import type { MemoryOwner } from "@friday/core";
import type { JournalAppend } from "@friday/tools";

/**
 * Warn about notes a journal write did not keep whole: `memory.journal_full` (day file full, `dropped` notes lost) or
 * `memory.journal_cut` (`cut` notes shortened to the note limit). `owner` names the journal (`bot:<id>` or
 * `group:<id>`). Nothing is logged for a clean write.
 */
export function logJournalAppend(
  log: { warn(o: object, msg: string): void },
  owner: MemoryOwner,
  r: JournalAppend,
): void {
  const name = owner.kind === "bot" ? `bot:${owner.botId}` : `group:${owner.groupId}`;
  if (r.status === "full") log.warn({ owner: name, dropped: r.dropped }, "memory.journal_full");
  else if (r.cut > 0) log.warn({ owner: name, cut: r.cut }, "memory.journal_cut");
}
