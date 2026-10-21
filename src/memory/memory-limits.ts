/* Values of the memory domain that the memory tools' `constants.ts` need. Leaf file (no imports), so a tool constants
   file never pulls in the writers or the index. */

/** Max chars of ONE note stored by `saveMemoryBullet` / `saveJournalBullet` (the `MemorySave` limit is this same number; a format guard, the files themselves have no size cap). */
export const SAVE_MAX_CHARS = 2000;

/** Sources of a memory entry (the `scope` values of MemorySearch). */
export const SOURCES = ["root", "channel", "journal", "summary"] as const;
export type Source = (typeof SOURCES)[number];
