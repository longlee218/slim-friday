import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { logEvent, logger } from "../observability/logger";
import {
  MemoryBusyError,
  MemorySymlinkError,
  withMemoryLock,
  writeAtomic,
} from "./memory-file-lock";
import { SAVE_MAX_CHARS } from "./memory-limits";
import {
  formatBullet,
  hasBullet,
  hasJournalBullet,
  insertBullet,
  insertJournalEntry,
  journalHeader,
  type MemoryKind,
  normalizeBullet,
} from "./memory-sections";
import { sanitizeBullet } from "./sanitize-bullet";

/** Max chars of a journal block label (thread title or location name). */
const JOURNAL_LABEL_CHARS = 60;

/** Line guard of ONE journal day file (runaway-flush guard): a journal write is refused at this size, never trimmed. Channel `MEMORY.md` has no size limit. */
export const OWNER_MAX_LINES = 300;

/** Logger of this module. */
const log = logger.child({ module: "memory-section-writer" });

/** Outcome of a sectioned write: `empty` = nothing left after sanitizing, `duplicate` = already there, `full` = a journal write would pass the line limit, `busy` = lock timeout. */
export type SaveResult = "saved" | "duplicate" | "full" | "empty" | "busy" | "symlink";

/** Where a note goes in a journal file: the `## HH:MM <label>` block. */
export interface JournalSlot {
  hhmm: string;
  label: string;
  /** True = a note already anywhere in the day file is a duplicate (checked inside the file lock). */
  dedupeDay?: boolean;
}

/** True when any bullet of the file has the same normalized key as `bullet` (an empty key never matches). */
function dayHasBullet(old: string, bullet: string): boolean {
  const key = normalizeBullet(bullet);
  return (
    key !== "" && old.split("\n").some((l) => l.startsWith("- ") && normalizeBullet(l) === key)
  );
}

/**
 * Shared locked read-modify-write of the sectioned writers. `edit` gets the current text (or `header` when the
 * file is new) and returns the new text, or "duplicate" / "full" for "nothing to write". Lock failures become a result, never a throw.
 */
function writeSectioned(
  file: string,
  header: string,
  edit: (old: string) => string | "duplicate" | "full",
  fields: Record<string, unknown>,
): SaveResult {
  mkdirSync(dirname(file), { recursive: true });
  try {
    return withMemoryLock(file, () => {
      const next = edit(existsSync(file) ? readFileSync(file, "utf8") : header);
      if (next === "duplicate" || next === "full") return next;
      writeAtomic(file, next);
      logEvent(log, "memory.sectioned", fields);
      return "saved";
    });
  } catch (err) {
    if (!(err instanceof MemoryBusyError || err instanceof MemorySymlinkError)) throw err;
    const reason = err instanceof MemorySymlinkError ? "symlink" : "busy";
    logEvent(log, "memory.write_failed", { ...fields, reason }, "warn");
    return reason;
  }
}

/**
 * Save one note into a MEMORY.md under the section of `kind` (created at the end when missing; existing text
 * untouched). Text is sanitized (one line, redacted, markup stripped, SAVE_MAX_CHARS), stamped ` (date)`, and
 * skipped when the section already has the same note. `header` is the content of a file that does not exist yet.
 * `date` is `YYYY-MM-DD`. No size limit on the file (owner decision): only the per-note SAVE_MAX_CHARS applies. The caller picks the file.
 */
export function saveMemoryBullet(
  file: string,
  header: string,
  kind: MemoryKind,
  text: string,
  date: string,
  fields: Record<string, unknown> = {},
): SaveResult {
  const clean = sanitizeBullet(text, SAVE_MAX_CHARS);
  if (!clean) return "empty";
  const bullet = formatBullet(clean, date);
  return writeSectioned(
    file,
    header,
    (old) => {
      if (hasBullet(old, kind, bullet)) return "duplicate";
      return insertBullet(old, kind, bullet);
    },
    { ...fields, kind, layer: "sectioned" },
  );
}

/**
 * Save one note into the daily journal file under `## HH:MM <label>` / `### <Kind>`. The same time+label in
 * the same file reuses its block. `label` (thread or location) is sanitized to one short line.
 */
export function saveJournalBullet(
  file: string,
  slot: JournalSlot,
  kind: MemoryKind,
  text: string,
  date: string,
  fields: Record<string, unknown> = {},
): SaveResult {
  const clean = sanitizeBullet(text, SAVE_MAX_CHARS);
  const label = sanitizeBullet(slot.label, JOURNAL_LABEL_CHARS);
  if (!clean || !label) return "empty";
  const bullet = formatBullet(clean, date);
  return writeSectioned(
    file,
    journalHeader(date),
    (old) => {
      if (hasJournalBullet(old, slot.hhmm, label, kind, bullet)) return "duplicate";
      if (slot.dedupeDay && dayHasBullet(old, bullet)) return "duplicate";
      const next = insertJournalEntry(old, slot.hhmm, label, kind, bullet);
      return next.trimEnd().split("\n").length > OWNER_MAX_LINES ? "full" : next;
    },
    { ...fields, kind, layer: "journal" },
  );
}
