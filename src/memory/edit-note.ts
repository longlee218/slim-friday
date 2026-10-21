import {
  MEMORY_SAVE_MAX_CHARS,
  MEMORY_SAVE_MIN_CHARS,
} from "../mcp/memory/tools/MemorySaveTool/constants";
import { parseId } from "./index/memory-ids";
import { auditWrite } from "./memory-audit";
import { localDay } from "./memory-clock";
import { editChannelBullet } from "./memory-edit-writer";
import { channelTarget } from "./memory-targets";
import type { MemoryToolContext } from "./memory-tool-context";
import type { MemorySaveOutcome } from "./save-note";

/** Arguments of one `MemoryEdit` call (already shape-checked by zod). */
export interface MemoryEditArgs {
  action: "delete" | "replace";
  /** Entry id of the bullet, as MemorySearch / MemoryGet return it. */
  id: string;
  /** New text of the bullet (`replace` only). */
  text?: string;
}

const fail = (text: string, result: string): MemorySaveOutcome => ({ text, isError: true, result });

/** Model-facing refusal per writer result (never names the file or its text). */
const REFUSALS: Record<string, [string, string]> = {
  not_found: ["entry not found: it moved or was edited. Run MemorySearch again.", "not_found"],
  not_bullet: [
    "only a bullet inside a Decisions, Facts, Preferences or Lessons section can be changed",
    "not_bullet",
  ],
  not_utf8: ["memory file is not valid UTF-8: refused", "not_utf8"],
  empty: ["nothing left after cleaning the text", "empty"],
  duplicate: ["another bullet already has this text", "duplicate"],
  busy: ["memory file is busy: try again in a moment", "busy"],
  symlink: ["memory file is a symlink: refused", "symlink"],
};

/**
 * Delete or replace ONE bullet of the run's channel MEMORY.md. The id must be a channel id of THIS channel (any other
 * id, a journal or root id, a summary, is refused before a file is opened). `now` is read once by the caller.
 * Audited (`edit_delete` | `edit_replace`, hash only) and re-indexed by the caller's `onSaved`. Never throws for a bad argument.
 */
export function editNote(ctx: MemoryToolContext, a: MemoryEditArgs, now: Date): MemorySaveOutcome {
  if (!ctx.channel) return fail("this run has no channel: memory notes need one", "no_channel");
  const id = parseId(a.id);
  if (id?.type !== "file" || id.source !== "channel" || id.channel !== ctx.channel)
    return fail("id is not a bullet of this channel's MEMORY.md", "bad_id");
  let text = "";
  if (a.action === "replace") {
    text = (a.text ?? "").trim();
    if (text.length < MEMORY_SAVE_MIN_CHARS) return fail("text too short", "too_short");
    if (text.length > MEMORY_SAVE_MAX_CHARS)
      return fail(`text too long (max ${MEMORY_SAVE_MAX_CHARS} chars): shorten it`, "too_long");
  }
  const t = channelTarget(ctx.home, ctx.workspace, ctx.channel);
  const res = editChannelBullet({
    file: t.file,
    home: ctx.home,
    workspace: ctx.workspace,
    channel: ctx.channel,
    id,
    op: a.action === "delete" ? { action: "delete" } : { action: "replace", text },
    date: localDay(now),
    now,
  });
  if (!res.ok) {
    const [msg, code] = REFUSALS[res.result] ?? [res.result, res.result];
    return fail(msg, code);
  }
  auditWrite(ctx, now, {
    action: a.action === "delete" ? "edit_delete" : "edit_replace",
    scope: "channel",
    hash: res.hash,
    oldHash: res.oldHash,
  });
  ctx.onSaved?.(t.file);
  return {
    text:
      a.action === "delete"
        ? "deleted from this channel's memory"
        : "replaced in this channel's memory (new id: run MemorySearch)",
    isError: false,
    result: a.action === "delete" ? "deleted" : "replaced",
  };
}
