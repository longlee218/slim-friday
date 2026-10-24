import type { JournalAppend } from "@friday/tools";

/**
 * Warn about notes a journal write did not keep whole: `memory.journal_full` (day file full, `dropped` notes lost) or
 * `memory.journal_cut` (`cut` notes shortened to the note limit). Nothing is logged for a clean write.
 */
export function logJournalAppend(
  log: { warn(o: object, msg: string): void },
  botId: string,
  r: JournalAppend,
  notes: number,
): void {
  if (r.status === "full") log.warn({ botId, dropped: notes }, "memory.journal_full");
  else if (r.cut > 0) log.warn({ botId, cut: r.cut }, "memory.journal_cut");
}
