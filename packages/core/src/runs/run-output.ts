import type { Author } from "../domain/message";
import type { RunStep } from "../domain/run";
import type { HubContext } from "../hub/hub-context";
import { errText } from "../hub/hub-types";
import { postStored } from "../hub/post-stored";
import { redactSecrets, redactStep, secretsFrom } from "../safety/redact-secrets";
import { postProgress } from "./progress-budget";
import type { RunExec } from "./run-exec";
import { runKindOf, silenceAllowed, talksToOwner } from "./run-kind";
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
  if (as === "narration") await onNarration(ctx, exec, text);
  else await onAnswerText(ctx, exec, text);
}

/**
 * A text written before a tool call: always a live run step. An owner run also stores it as a progress message
 * while the budget allows (60 s old, 3 per run); otherwise it is not stored (spec §6.2).
 */
export async function onNarration(ctx: HubContext, exec: RunExec, text: string): Promise<void> {
  showStep(ctx, exec, exec.steps.onNarration(text, ctx.deps.clock.now()));
  if (runKindOf(exec.row) !== "owner") return;
  await postProgress(ctx, exec, text).catch((err) =>
    ctx.deps.log?.error({ error: errText(err), wakeId: exec.row.id }, "hub.progress_failed"),
  );
}

/**
 * An answer text. Prose is stored and posted with the steps since the previous text (a sentinel at its edge
 * stripped) and becomes the run's final so far; the bare sentinel or an empty text is not posted and keeps
 * the earlier final.
 */
export async function onAnswerText(ctx: HubContext, exec: RunExec, text: string): Promise<void> {
  const prose = isSilent(text) ? "" : stripSentinel(text);
  if (!prose) return;
  exec.finalText = prose;
  await post(ctx, exec, prose);
}

/**
 * The run's output once it is done; returns the result text (returned to a delegating bot): the last prose
 * answer of the run, posted already (a later silent or empty turn does not erase it). An answer an earlier
 * attempt stored before a cut counts too (`exec.finalText` lives only in this attempt's memory), so a resumed
 * run that ends with no text neither posts "done." after it nor returns nothing. A run with no prose
 * answer returns none (nothing goes back, as before) and posts nothing when
 * the run may stay silent (ticket, bot `fyi` that answers no request) or when progress notes were posted in the
 * run (the hollow-final rule, R§4); otherwise it posts "done.".
 */
export async function settleOutput(ctx: HubContext, exec: RunExec): Promise<string | undefined> {
  await releaseHeld(ctx, exec, "answer");
  const answer = exec.finalText || (await ctx.deps.store.messages.lastText(exec.row.id));
  if (answer) {
    exec.announceText = answer;
    return answer;
  }
  if (silenceAllowed(exec.row, runKindOf(exec.row))) return undefined;
  if ((await ctx.deps.store.messages.countInterim(exec.row.id)) > 0) return undefined;
  await post(ctx, exec, EMPTY_FINAL);
  exec.announceText = EMPTY_FINAL;
  return undefined;
}

/** Longest finished preview (code points). */
export const FINISHED_PREVIEW_CHARS = 180;

/**
 * Tell the surface the run's final answer was posted to the owner: redacted, newlines collapsed to spaces,
 * cut to 180 code points. Nothing for a run that does not talk to the owner (ticket, intro, bot-to-bot).
 * A surface failure never fails the run. Called by the executor once `finishRun` committed (a run that lost
 * its lease announces nothing; the new holder does).
 */
export function announceFinished(ctx: HubContext, exec: RunExec): void {
  const text = exec.announceText;
  if (text === undefined || !talksToOwner(exec.row)) return;
  const flat = redactSecrets(text, secretsFrom(ctx.deps.secretValues)).replace(/\s+/g, " ").trim();
  const points = [...flat];
  const preview =
    points.length > FINISHED_PREVIEW_CHARS
      ? `${points
          .slice(0, FINISHED_PREVIEW_CHARS - 1)
          .join("")
          .trimEnd()}…`
      : flat;
  try {
    ctx.deps.surface.notifyFinished({
      conversationId: exec.current.conversationId,
      botId: exec.bot.id,
      preview,
    });
  } catch (err) {
    ctx.deps.log?.error({ error: errText(err), wakeId: exec.row.id }, "hub.finished_notice_failed");
  }
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
    // Ties the message to its run: the unread count skips runs that do not talk to the owner.
    wakeId: exec.row.id,
    ...(run.length > 0 && { run }),
  }).catch((err) =>
    ctx.deps.log?.error({ error: errText(err), conversationId }, "hub.post_failed"),
  );
}
