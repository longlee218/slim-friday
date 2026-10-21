import { workspacePaths } from "../config/workspace-paths";
import {
  MEMORY_SAVE_MAX_CHARS,
  MEMORY_SAVE_MIN_CHARS,
  type MemorySaveScope,
} from "../mcp/memory/tools/MemorySaveTool/constants";
import { localDay, localHhmm } from "./memory-clock";
import { saveJournalBullet, saveMemoryBullet } from "./memory-section-writer";
import { DEFAULT_KIND, KIND_HEADING, type MemoryKind } from "./memory-sections";
import { channelTarget } from "./memory-targets";
import type { MemoryToolContext } from "./memory-tool-context";

/** Arguments of one `MemorySave` call (already shape-checked by zod). */
export interface MemorySaveArgs {
  text: string;
  scope: MemorySaveScope;
  kind?: MemoryKind;
}

/** Outcome: the text the model reads, whether it is an error, and the short result word for the log. */
export interface MemorySaveOutcome {
  text: string;
  isError: boolean;
  result: string;
}

/** Refused write: the short text (becomes the detail of a trusted issue) and the result code `ISSUE_OF` maps. */
const fail = (text: string, result: string): MemorySaveOutcome => ({ text, isError: true, result });

/** Refusal text for a failed write (the model relays it). `full` happens only for a journal day file (line guard). */
const WRITE_ERRORS: Record<string, string> = {
  full: "today's journal file is full: this note was not saved",
  busy: "memory file is busy: try again in a moment",
  symlink: "memory file is a symlink: refused",
  empty: "nothing left to save after cleaning the text",
};

/**
 * Save one note. `now` is read ONCE by the caller: the file date and the bullet date come from the same instant.
 * Pure of state except the file write; never throws for a bad argument (returns an error outcome).
 */
export function saveNote(ctx: MemoryToolContext, a: MemorySaveArgs, now: Date): MemorySaveOutcome {
  const text = a.text.trim();
  if (text.length < MEMORY_SAVE_MIN_CHARS) return fail("text too short", "too_short");
  if (text.length > MEMORY_SAVE_MAX_CHARS)
    return fail(`text too long (max ${MEMORY_SAVE_MAX_CHARS} chars): shorten it`, "too_long");
  const kind = a.kind ?? DEFAULT_KIND;
  if (kind === "open" && a.scope !== "journal")
    return fail("kind open is only for scope journal", "bad_kind");

  const date = localDay(now);
  const fields = { workspace: ctx.workspace, channel: ctx.channel };
  const ws = workspacePaths(ctx.home).workspace(ctx.workspace);
  let file: string;
  let where: string;
  let save: () => ReturnType<typeof saveMemoryBullet>;
  switch (a.scope) {
    case "channel": {
      if (!ctx.channel) return fail("this run has no channel: memory notes need one", "no_channel");
      const t = channelTarget(ctx.home, ctx.workspace, ctx.channel);
      [file, where] = [t.file, `channel/${ctx.channel}`];
      save = () =>
        saveMemoryBullet(t.file, t.template, kind, text, date, { ...fields, channel: ctx.channel });
      break;
    }
    case "journal": {
      if (!ctx.channel) return fail("this run has no channel: memory notes need one", "no_channel");
      file = ws.channel(ctx.channel).journal(date);
      where = "journal";
      const slot = { hhmm: localHhmm(now), label: ctx.threadLabel };
      save = () => saveJournalBullet(file, slot, kind, text, date, fields);
      break;
    }
  }
  const res = save();
  if (res === "duplicate") return { text: "already saved", isError: false, result: res };
  if (res !== "saved") return fail(WRITE_ERRORS[res] ?? res, res);
  ctx.onSaved?.(file);
  return {
    text: `saved to ${where} (${KIND_HEADING[kind]})`,
    isError: false,
    result: res,
  };
}
