import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import {
  MEMORY_SAVE_MAX_CHARS,
  MEMORY_SAVE_MIN_CHARS,
  type MemorySaveScope,
} from "../mcp/memory/tools/MemorySaveTool/constants";
import { logEvent, logger } from "../observability/logger";
import { bulletHash } from "./bullet-hash";
import { makeId } from "./index/memory-ids";
import { formatLesson } from "./lesson-format";
import { auditWrite } from "./memory-audit";
import { localDay, localHhmm } from "./memory-clock";
import { OWNER_MAX_LINES, saveJournalBullet, saveMemoryBullet } from "./memory-section-writer";
import { DEFAULT_KIND, KIND_HEADING, type MemoryKind } from "./memory-sections";
import { channelTarget } from "./memory-targets";
import type { MemoryToolContext } from "./memory-tool-context";
import { sanitizeBullet } from "./sanitize-bullet";

const log = logger.child({ module: "save-note" });

/** Arguments of one `MemorySave` call (already shape-checked by zod). */
export interface MemorySaveArgs {
  text: string;
  scope: MemorySaveScope;
  kind?: MemoryKind;
  /** True = write even when a similar bullet exists (exact duplicates are still refused). Channel scope only. */
  confirmNew?: boolean;
  /** Kind lesson only (required): the situation the lesson applies to. */
  cue?: string;
  /** Kind lesson only (required): the run, item or message that showed it. */
  evidence?: string;
}

/** Outcome: the text the model reads, whether it is an error, and the short result word for the log. */
export interface MemorySaveOutcome {
  text: string;
  isError: boolean;
  result: string;
}

/** Refused write: the short text (becomes the detail of a trusted issue) and the result code `ISSUE_OF` maps. */
const fail = (text: string, result: string): MemorySaveOutcome => ({ text, isError: true, result });

/** Refusal text for a failed write (the model relays it). `full` has its own text (it names the day file). */
const WRITE_ERRORS: Record<string, string> = {
  busy: "memory file is busy: try again in a moment",
  symlink: "memory file is a symlink: refused",
  not_utf8: "memory file is not valid UTF-8: refused",
  empty: "nothing left to save after cleaning the text",
};

/**
 * Refusal for a journal day file at the line guard: names the day file and the guard, and logs a warn with the counts
 * (never the note text).
 */
function journalFullText(file: string): string {
  let lines = 0;
  try {
    lines = readFileSync(file, "utf8").trimEnd().split("\n").length;
  } catch {
    // the count is a log field only
  }
  logEvent(log, "memory.journal_full", { lines, max: OWNER_MAX_LINES }, "warn");
  return `journal day file ${basename(file)} is full (${OWNER_MAX_LINES}-line guard per day file): this note was not saved; save it to scope channel or tomorrow`;
}

/**
 * Save one note. `now` is read ONCE by the caller: the file date and the bullet date come from the same instant.
 * Pure of state except the file write; never throws for a bad argument (returns an error outcome).
 */
export function saveNote(ctx: MemoryToolContext, a: MemorySaveArgs, now: Date): MemorySaveOutcome {
  const kind = a.kind ?? DEFAULT_KIND;
  // A lesson is stored in its one-line form; without a cue and evidence it is a guess and is refused.
  if (kind === "lesson" && (!a.cue?.trim() || !a.evidence?.trim()))
    return fail("a lesson needs cue (the situation) and evidence (what showed it)", "bad_lesson");
  const text =
    kind === "lesson"
      ? formatLesson({ cue: a.cue ?? "", lesson: a.text, evidence: a.evidence ?? "" })
      : a.text.trim();
  if (text.length < MEMORY_SAVE_MIN_CHARS) return fail("text too short", "too_short");
  if (text.length > MEMORY_SAVE_MAX_CHARS)
    return fail(`text too long (max ${MEMORY_SAVE_MAX_CHARS} chars): shorten it`, "too_long");
  if (kind === "open" && a.scope !== "journal")
    return fail("kind open is only for scope journal", "bad_kind");

  const date = localDay(now);
  const fields = { workspace: ctx.workspace, channel: ctx.channel };
  const ws = workspacePaths(ctx.home).workspace(ctx.workspace);
  let file: string;
  let where: string;
  let save: () => ReturnType<typeof saveMemoryBullet>;
  let prefix = ""; // id prefix of the channel file (for the id of a near-duplicate)
  switch (a.scope) {
    case "channel": {
      if (!ctx.channel) return fail("this run has no channel: memory notes need one", "no_channel");
      const t = channelTarget(ctx.home, ctx.workspace, ctx.channel);
      [file, where] = [t.file, `channel/${ctx.channel}`];
      prefix = where;
      save = () =>
        saveMemoryBullet(
          t.file,
          t.template,
          kind,
          text,
          date,
          { ...fields, channel: ctx.channel },
          a.confirmNew === true,
        );
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
  if (typeof res === "object") {
    // A near-duplicate is not written: name it so the teammate can change it with MemoryEdit (not an error, nothing failed).
    const id = makeId(prefix, res.similar.token, res.similar.n, res.similar.hash);
    return {
      text: `not saved: a similar note already exists (id ${id}). Read it with MemoryGet; change it with MemoryEdit replace, skip, or repeat with confirmNew: true if this is a different fact.`,
      isError: false,
      result: "similar",
    };
  }
  if (res === "duplicate") return { text: "already saved", isError: false, result: res };
  if (res === "full") return fail(journalFullText(file), res);
  if (res !== "saved") return fail(WRITE_ERRORS[res] ?? res, res);
  auditWrite(ctx, now, {
    action: "save",
    scope: a.scope,
    hash: bulletHash(sanitizeBullet(text, MEMORY_SAVE_MAX_CHARS)),
  });
  ctx.onSaved?.(file);
  return {
    text: `saved to ${where} (${KIND_HEADING[kind]})`,
    isError: false,
    result: res,
  };
}
