import type { MemoryOwner } from "@friday/core";
import { JOURNAL_MAX_LINES, journalDays, journalEntries, readConsolidatedMark } from "./journal";
import { MEMORY_NOTE_MAX_CHARS } from "./sanitize-bullet";

/** Most journal notes sent in one consolidation run: a whole day file always fits. */
const MAX_NOTES = JOURNAL_MAX_LINES;
/** Most characters of journal notes sent in one consolidation run: a whole day file always fits. */
const MAX_CHARS = JOURNAL_MAX_LINES * (MEMORY_NOTE_MAX_CHARS + 1);

/** Journal notes not yet consolidated, and the mark to write once they are: `count` = all notes of `day`. */
export interface PendingNotes {
  entries: { note: string; label: string }[];
  through?: { day: string; count: number };
}

/**
 * Notes after the owner's mark, oldest day first (today included), within the caps. On the mark day the first `count`
 * notes are skipped (an old mark without a count skips the day; a day with fewer notes than `count` had lines deleted
 * and counts as consumed). A day that does not fit whole is left for the next run; the first day is always sent whole
 * (also a hand-edited one over the caps), so the mark never passes a note that was not sent.
 */
export function pendingNotes(root: string, owner: MemoryOwner): PendingNotes {
  const mark = readConsolidatedMark(root, owner);
  const entries: PendingNotes["entries"] = [];
  let chars = 0;
  let through: PendingNotes["through"];
  for (const day of journalDays(root, owner)) {
    if (mark && day < mark.day) continue;
    const all = journalEntries(root, owner, day);
    const dayEntries = mark?.day === day ? all.slice(mark.count ?? all.length) : all;
    if (mark?.day === day && !dayEntries.length) continue;
    const size = dayEntries.reduce((n, e) => n + e.note.length, 0);
    if (through && (entries.length + dayEntries.length > MAX_NOTES || chars + size > MAX_CHARS))
      break;
    entries.push(...dayEntries);
    chars += size;
    through = { day, count: all.length };
  }
  return { entries, through };
}
