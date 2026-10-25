import type { RunStep } from "../domain/run";
import type { HubContext } from "../hub/hub-context";
import type { RuntimeEvent } from "../ports/agent-runtime";
import { parkNow } from "./run-cards";
import { abortRun, type RunExec } from "./run-exec";
import { noFinalAnswerError, nudgeOrEnd } from "./run-nudge";
import { holdText, onAnswerText, releaseHeld, showStep } from "./run-output";
import { dayOf } from "./run-rules";
import { answerFirstTurn, answerPushed, deliverSteering } from "./run-steering";
import { onTaintCall, onTaintResult } from "./run-taint";
import type { StreamWatchdog } from "./run-watchdog";

/** How a run's event stream ended: the work is done, it failed, or the run was cut short (`exec.stop`). */
export type PumpEnd = { kind: "done" } | { kind: "error"; err: unknown } | { kind: "stopped" };

/** A runtime error event as an error value; `retryable` marks a transient failure. */
const eventError = (message: string, retryable: boolean) =>
  Object.assign(new Error(message), { retryable });

/**
 * Read one run's session events until the run is done: a `turn_end` with no background task open and no
 * follow-up turn of a finished task still to come. Bot text is held until the next event says if it
 * was narration or an answer (`run-output.ts`), steps shown, costs added to
 * the spend total. Every event re-arms the run's stream watchdog `dog` (armed at the claim, stopped by the
 * executor).
 */
export async function pumpRun(
  ctx: HubContext,
  exec: RunExec,
  dog: StreamWatchdog,
): Promise<PumpEnd> {
  const session = exec.session;
  if (!session) return { kind: "error", err: new Error("no session") };
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
  // Any event after a turn end means the follow-up came (or the run goes on): no grace end.
  exec.cancelGrace?.();
  delete exec.cancelGrace;
  const conversationId = exec.current.conversationId;
  /** Shows a step in the run line of the current conversation. */
  const show = (step?: RunStep) => showStep(ctx, exec, step);
  if (e.type === "thinking") {
    exec.turnOpen = true;
    show(exec.steps.onThinking(now));
  } else if (e.type === "tool_call") {
    exec.turnOpen = true;
    exec.lastWasToolResult = false;
    // A text held before this call was narration.
    await releaseHeld(ctx, exec, "narration");
    exec.openTools.add(e.toolUseId);
    onTaintCall(exec, e.toolUseId, e.tool);
    for (const s of exec.steps.onToolCall(e, now)) show(s);
  } else if (e.type === "tool_result") {
    exec.openTools.delete(e.toolUseId);
    exec.lastWasToolResult = true;
    show(exec.steps.onToolResult(e, now));
    // The first result from outside taints the run, stored on the row (spec §6.10).
    await onTaintResult(ctx, exec, e.toolUseId, e.urls);
    // This result followed the earlier pushes: the model read them. Then push what came while the tool ran.
    await answerPushed(ctx, exec);
    await deliverSteering(ctx, exec, false);
  } else if (e.type === "text") {
    exec.turnOpen = true;
    exec.lastWasToolResult = false;
    show(exec.steps.closeThinking(now));
    await holdText(ctx, exec, e.text);
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
    exec.lastWasToolResult = false;
    // The result is the bot's next turn; it speaks where the task began. A task that ends after the turn ended
    // gets a follow-up turn of its own, which the run waits for.
    if (task) exec.current = { conversationId: task.conversationId, hop: task.hop };
    if (exec.turnOpen) exec.taskDoneInTurn = true;
    else exec.followUp = true;
    // The last task ended while a card is still open: the run parks now (spec: subagent exception).
    if (exec.tasks.size === 0 && exec.waiting) parkNow(exec);
  } else if (e.type === "turn_end") {
    // A text held to the turn's end is an answer.
    await releaseHeld(ctx, exec, "answer");
    show(exec.steps.endTurn(now));
    exec.turnOpen = false;
    // A steering push still being claimed learns the turn is over before the run is finished.
    await exec.delivering;
    // The first turn is answered with its end, rows it carried are done.
    await answerFirstTurn(ctx, exec);
    exec.followUp = false;
    await store.spend.add(exec.bot.id, dayOf(now), e.costUsd);
    const taskDoneInTurn = exec.taskDoneInTurn;
    exec.taskDoneInTurn = false;
    // A background task still runs: the run waits for it, never nudged or failed (spec §6.5).
    if (exec.tasks.size > 0 || taskDoneInTurn) exec.lastWasToolResult = false;
    if (exec.tasks.size > 0) return undefined;
    if (!taskDoneInTurn) {
      // A turn that ended right after a tool result is nudged to continue, up to 3 times (`run-nudge.ts`).
      const next = await nudgeOrEnd(ctx, exec);
      if (next === "nudged") return undefined;
      if (next === "fail") return { kind: "error", err: noFinalAnswerError() };
      return { kind: "done" };
    }
    // A task finished during this turn: its follow-up turn may still come. Wait for it a short grace.
    exec.cancelGrace = clock.setTimer(ctx.limits.followUpGraceMs, () =>
      abortRun(exec, { kind: "followUpOver" }),
    );
  } else if (e.type === "guard_stop") {
    // The loop guard or the tool-call cap stopped the run: its text is the final answer.
    await releaseHeld(ctx, exec, "narration");
    await onAnswerText(ctx, exec, e.text);
    // The first turn's rows were answered by this stop (no turn_end comes); rows pushed later stay as they are.
    await answerFirstTurn(ctx, exec);
    return { kind: "done" };
  } else if (e.type === "error") {
    await releaseHeld(ctx, exec, "answer");
    return { kind: "error", err: eventError(e.message, e.retryable) };
  }
  return undefined;
}
