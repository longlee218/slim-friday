import type { HubContext } from "../hub/hub-context";
import { postStored } from "../hub/post-stored";
import type { RunExec } from "./run-exec";
import { scheduleTagOf } from "./run-schedule-tag";

/** Longest progress update (PostUpdate or promoted narration); longer text is cut (spec §6.2). */
export const PROGRESS_MAX_CHARS = 500;
/** No durable progress message before the run is this old (ms). */
export const PROGRESS_MIN_RUN_AGE_MS = 60_000;
/** Most durable progress messages per run: PostUpdate and promoted narration together. */
export const PROGRESS_MAX_PER_RUN = 3;

/** What `PostUpdate` returns: posted (and whether the text was cut), or why not. */
export type PostUpdateResult =
  | { posted: true; cut: boolean }
  | { posted: false; reason: "fresh" | "budget" };

/**
 * Whether the run may post one more progress message now: `fresh` (run under 60 s old), `budget` (3 already
 * stored for this wake) or `ok`. The count comes from the store per wake id, so it survives a cut and a resume.
 */
export async function progressBudget(
  ctx: HubContext,
  exec: RunExec,
  now: number,
): Promise<"fresh" | "budget" | "ok"> {
  const startedAt = exec.row.startedAt ?? exec.openedAt;
  if (now - startedAt < PROGRESS_MIN_RUN_AGE_MS) return "fresh";
  const used = await ctx.deps.store.messages.countInterim(exec.row.id);
  return used >= PROGRESS_MAX_PER_RUN ? "budget" : "ok";
}

/** Trim and cut to the cap (the last kept char becomes an ellipsis); `cut` tells if text was lost. */
export function clampProgress(text: string): { text: string; cut: boolean } {
  const t = text.trim();
  if (t.length <= PROGRESS_MAX_CHARS) return { text: t, cut: false };
  return { text: `${t.slice(0, PROGRESS_MAX_CHARS - 1).trimEnd()}…`, cut: true };
}

/**
 * Post one progress message if the budget allows: stored with `kind: "progress"` and the wake id (so it is
 * counted), through `postStored` (secrets redacted), in the conversation the run answers now.
 */
export async function postProgress(
  ctx: HubContext,
  exec: RunExec,
  raw: string,
): Promise<PostUpdateResult> {
  const now = ctx.deps.clock.now();
  const state = await progressBudget(ctx, exec, now);
  if (state !== "ok") return { posted: false, reason: state };
  const { text, cut } = clampProgress(raw);
  await postStored(ctx.deps, {
    conversationId: exec.current.conversationId,
    author: { kind: "bot", botId: exec.bot.id },
    text,
    at: now,
    kind: "progress",
    wakeId: exec.row.id,
    ...(await scheduleTagOf(ctx, exec)),
  });
  return { posted: true, cut };
}
