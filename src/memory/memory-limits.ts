/* Values of the memory domain that the memory tools' `constants.ts` need. Leaf file (no imports), so a tool constants
   file never pulls in the writers or the index. */

/** Max chars of a note stored by `saveMemoryBullet` / `saveJournalBullet` (the `MemorySave` limit is this same number). */
export const SAVE_MAX_CHARS = 400;

/** Sources of a memory entry (the `scope` values of MemorySearch). */
export const SOURCES = ["root", "workspace", "channel", "location", "journal", "summary"] as const;
export type Source = (typeof SOURCES)[number];
