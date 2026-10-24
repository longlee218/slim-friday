import type { Author } from "../domain/message";
import type { RunStep } from "../domain/run";
import type { HubContext } from "../hub/hub-context";
import { errText } from "../hub/hub-types";
import { postStored } from "../hub/post-stored";
import type { RuntimeEvent } from "../ports/agent-runtime";
import { abortRun, type RunExec } from "./run-exec";
import { dayOf } from "./run-rules";
import { StreamWatchdog } from "./run-watchdog";

/** How a run's event stream ended: the work is done, it failed, or the run was cut short (`exec.stop`). */
export type PumpEnd = { kind: "done" } | { kind: "error"; err: unknown } | { kind: "stopped" };

/** A runtime error event as an error value; `retryable` marks a transient failure. */
const eventError = (message: string, retryable: boolean) =>
  Object.assign(new Error(message), { retryable });

/**
 * Read one run's session events until the run is done: a `turn_end` with no background task open and no
 * follow-up turn of a finished task still to come. Bot text is stored and posted, steps shown, costs added to
 * the spend total. The stream watchdog cuts a stream that is silent for `streamIdleMs` while no tool call or
 * task runs.
 */
export async function pumpRun(ctx: HubContext, exec: RunExec): Promise<PumpEnd> {
  const session = exec.session;
  if (!session) return { kind: "error", err: new Error("no session") };
  const dog = new StreamWatchdog(
    ctx.deps.clock,
    ctx.limits.streamIdleMs,
    () => exec.openTools.size > 0 || exec.tasks.size > 0,
    () => abortRun(exec, { kind: "idle" }),
  );
  dog.arm();
  try {
    for await (const e of session.events) {
      if (exec.stop) break;
      dog.arm();
      const end = await onEvent(ctx, exec, e);
      if (end) return end;
    }
    if (exec.stop) return { kind: "stopped" };
    return { kind: "error", err: new Error("the session ended unexpectedly") };
  } catch (err) {
    return exec.stop ? { kind: "stopped" } : { kind: "error", err };
  } finally {
    dog.stop();
  }
}

/** Handle one event; returns how the run ended when this event ends it. */
async function onEvent(
  ctx: HubContext,
  exec: RunExec,
  e: RuntimeEvent,
): Promise<PumpEnd | undefined> {
  const { surface, store, clock } = ctx.deps;
  const now = clock.now();
  const conversationId = exec.current.conversationId;
  /** Shows a step in the run line of the current conversation. */
  const show = (step?: RunStep) => step && surface.showRun(conversationId, exec.bot.id, step);
  if (e.type === "thinking") {
    exec.turnOpen = true;
    show(exec.steps.onThinking(now));
  } else if (e.type === "tool_call") {
    exec.turnOpen = true;
    exec.openTools.add(e.toolUseId);
    for (const s of exec.steps.onToolCall(e, now)) show(s);
  } else if (e.type === "tool_result") {
    exec.openTools.delete(e.toolUseId);
    show(exec.steps.onToolResult(e, now));
  } else if (e.type === "text") {
    exec.turnOpen = true;
    show(exec.steps.closeThinking(now));
    await onText(ctx, exec, e.text);
  } else if (e.type === "task_started") {
    show(exec.steps.onTask(e, now));
    exec.tasks.set(e.taskId, { description: e.description, ...exec.current });
    surface.showActivity(conversationId, {
      kind: "subagent",
      botId: exec.bot.id,
      label: e.description,
    });
  } else if (e.type === "task_done") {
    show(exec.steps.onTask(e, now));
    const task = exec.tasks.get(e.taskId);
    exec.tasks.delete(e.taskId);
    // The result is the bot's next turn; it speaks where the task began. A task that ends after the turn ended
    // gets a follow-up turn of its own, which the run waits for.
    if (task) exec.current = { conversationId: task.conversationId, hop: task.hop };
    if (!exec.turnOpen) exec.followUp = true;
  } else if (e.type === "turn_end") {
    show(exec.steps.endTurn(now));
    exec.turnOpen = false;
    exec.followUp = false;
    await store.spend.add(exec.bot.id, dayOf(now), e.costUsd);
    if (exec.tasks.size === 0) return { kind: "done" };
  } else if (e.type === "error") {
    return { kind: "error", err: eventError(e.message, e.retryable) };
  }
  return undefined;
}

/** Store and post one bot text with the steps since the previous one; record the run's first text. */
async function onText(ctx: HubContext, exec: RunExec, text: string): Promise<void> {
  const { clock, store } = ctx.deps;
  const author: Author = { kind: "bot", botId: exec.bot.id };
  const conversationId = exec.current.conversationId;
  const run = exec.steps.take(clock.now());
  // Text goes to the channel only; a bot reaches another bot with SendToBot / HandOff.
  await postStored(ctx.deps, {
    conversationId,
    author,
    text,
    at: clock.now(),
    ...(run.length > 0 && { run }),
  }).catch((err) =>
    ctx.deps.log?.error({ error: errText(err), conversationId }, "hub.post_failed"),
  );
  exec.turnTexts.push(text);
  if (exec.firstTextSeen) return;
  exec.firstTextSeen = true;
  const { id, leaseFence } = exec.row;
  await store.wakes.transition(id, leaseFence, ["running"], { firstTextAt: clock.now() });
}
