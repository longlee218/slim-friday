import type { Author } from "../domain/message";
import type { RunStep } from "../domain/run";
import type { HubContext } from "../hub/hub-context";
import { errText } from "../hub/hub-types";
import { postStored } from "../hub/post-stored";
import { redactStep, secretsFrom } from "../safety/redact-secrets";
import type { RunExec } from "./run-exec";
import { runKindOf, silenceAllowed } from "./run-kind";
import { isSilent, stripSentinel } from "./silent-reply";

/** What an owner run posts when its final answer is empty or the silence sentinel (spec §6.3). */
export const EMPTY_FINAL = "done.";

/** Show one step (secrets redacted) in the run line of the conversation the run answers now. */
export function showStep(ctx: HubContext, exec: RunExec, step?: RunStep): void {
  if (!step) return;
  const safe = redactStep(step, secretsFrom(ctx.deps.secretValues));
  ctx.deps.surface.showRun(exec.current.conversationId, exec.bot.id, safe);
}

/**
 * Hold a bot text until the next event says what it was (the runtime sends a text and its tool call as separate
 * messages, so only the next event tells): a held text before it is an answer. Records the run's first text.
 */
export async function holdText(ctx: HubContext, exec: RunExec, text: string): Promise<void> {
  await releaseHeld(ctx, exec, "answer");
  exec.heldText = text;
  if (exec.firstTextSeen) return;
  exec.firstTextSeen = true;
  const { id, leaseFence } = exec.row;
  const at = ctx.deps.clock.now();
  await ctx.deps.store.wakes.transition(id, leaseFence, ["running"], { firstTextAt: at });
}

/** Settle the held text, if any: a tool call follows it (`narration`), or the turn or another text does (`answer`). */
export async function releaseHeld(
  ctx: HubContext,
  exec: RunExec,
  as: "answer" | "narration",
): Promise<void> {
  const text = exec.heldText;
  if (text === undefined) return;
  delete exec.heldText;
  if (as === "narration") onNarration(ctx, exec, text);
  else await onAnswerText(ctx, exec, text);
}

/** A text written before a tool call: shown as a live run step, never stored as a message. */
export function onNarration(ctx: HubContext, exec: RunExec, text: string): void {
  showStep(ctx, exec, exec.steps.onNarration(text, ctx.deps.clock.now()));
}

/**
 * An answer text: it becomes the run's final so far. Prose is stored and posted with the steps since the
 * previous text (a sentinel at its edge stripped); the bare sentinel or an empty text is not posted.
 */
export async function onAnswerText(ctx: HubContext, exec: RunExec, text: string): Promise<void> {
  exec.finalText = text;
  const prose = isSilent(text) ? "" : stripSentinel(text);
  if (prose) await post(ctx, exec, prose);
}

/**
 * The run's output once it is done; returns the result text (returned to a delegating bot): the final's prose,
 * posted already. An empty or silent final returns none (nothing goes back, as before) and posts nothing when
 * the run may stay silent (ticket, bot `fyi` that answers no request) or when progress notes were posted in the
 * run (the hollow-final rule, R§4); otherwise it posts "done.".
 */
export async function settleOutput(ctx: HubContext, exec: RunExec): Promise<string | undefined> {
  await releaseHeld(ctx, exec, "answer");
  const final = exec.finalText ?? "";
  const prose = isSilent(final) ? "" : stripSentinel(final);
  if (prose) return prose;
  if (silenceAllowed(exec.row, runKindOf(exec.row))) return undefined;
  if ((await ctx.deps.store.messages.countInterim(exec.row.id)) > 0) return undefined;
  await post(ctx, exec, EMPTY_FINAL);
  return undefined;
}

/** Store and post one bot message in the conversation the run answers now, with the steps since the last one. */
async function post(ctx: HubContext, exec: RunExec, text: string): Promise<void> {
  const { clock } = ctx.deps;
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
}
