/* Limits of the memory jobs (flush after compaction, idle episodes, dreaming, prune).
   Time, cost and retention bounds of background work, NOT memory size caps: memory files have none.
   Plain constants: no env, no behaviour. */

/** Deadline (ms) of the post-compaction flush model call (one attempt, thinking off). */
export const FLUSH_DEADLINE_MS = 60_000;

/** Cost ceiling (USD) of one flush call. */
export const FLUSH_BUDGET_USD = 0.05;

/** Most notes one flush writes (the model's list is cut to this). */
export const FLUSH_MAX_ITEMS = 12;

/** Chars of the flush model input (summary + chat tail); the newest end is kept. */
export const FLUSH_INPUT_MAX_CHARS = 24_000;

/** Journal day files older than this many days are deleted at startup. */
export const JOURNAL_RETENTION_DAYS = 30;

/** Episodes (`thread_summaries` rows) not updated for this many days are deleted with their index rows. */
export const EPISODE_TTL_DAYS = 90;

/** A thread whose newest teammate turn ended this long ago (ms) is idle: it gets an episode. */
export const EPISODE_IDLE_MS = 7_200_000;

/** Most idle episodes one memory tick writes (the rest wait for the next tick). */
export const EPISODE_MAX_PER_TICK = 5;

/** Chars of an episode abstract (first sentences of its summary). */
export const EPISODE_ABSTRACT_CHARS = 500;

/** Most key topics (top terms) stored per episode. */
export const EPISODE_TOPICS_MAX = 8;

/** Chars of the idle-episode model input (thread facts from the db); the newest end is kept. */
export const EPISODE_INPUT_MAX_CHARS = 12_000;

/** Cost ceiling (USD) of one idle-episode model call. */
export const EPISODE_BUDGET_USD = 0.03;

/** Deadline (ms) of one idle-episode model call (one attempt, thinking off). */
export const EPISODE_DEADLINE_MS = 30_000;

/** Period (ms) of the memory tick (idle episodes, then prune when due). */
export const MEMORY_TICK_MS = 600_000;

/** Least time (ms) between two prune runs (episodes, journals); one run also happens at start. */
export const PRUNE_INTERVAL_MS = 21_600_000;

/** Least unpromoted items (episodes + journal blocks) of a channel before it dreams. */
export const DREAM_MIN_ITEMS = 5;

/** Most items one dream consumes (the oldest first; the rest wait for the next dream). */
export const DREAM_MAX_ITEMS = 10;

/** Least time (ms) between two dream attempts of one channel (a failed attempt counts too: no back-off). */
export const DREAM_DEBOUNCE_MS = 600_000;

/** Cost ceiling (USD) of one dream model call. */
export const DREAM_BUDGET_USD = 0.1;

/** Deadline (ms) of one dream model call (one attempt, thinking off). */
export const DREAM_DEADLINE_MS = 90_000;

/** Chars of one dream item sent to the model (an episode summary or the bullets of a journal block); the rest is cut. */
export const DREAM_ITEM_MAX_CHARS = 3000;

/**
 * Chars of the current dated notes sent to the model in one dream. Over it, the newest notes (by date, then file
 * position) within the cap are sent; the rest are not shown to the model and stay untouched in the file.
 */
export const DREAM_NOTES_MAX_CHARS = 40_000;

/** Backups of a channel `MEMORY.md` kept (the newest), one is written before each dream write. */
export const DREAM_BACKUP_KEEP = 20;

/** `MemoryEdit` backups of a channel `MEMORY.md` kept (the newest); own rotation, so edits and dreams never evict each other's backups. */
export const EDIT_BACKUP_KEEP = 20;

/**
 * Shrink guard: a dream is refused when more than this share of the existing dated bullets has no similar bullet in
 * the result AND that loss is bigger than the number of near-duplicates among them. A ratio of the job's own input,
 * never a size cap of the file.
 */
export const DREAM_MAX_DROP_SHARE = 0.5;

/** Most episode abstracts the teammate's per-turn prompt carries (the best FTS matches of the channel). */
export const INJECT_MAX_HITS = 3;

/** Chars of the whole "related earlier threads" block, heading included (lines that do not fit are dropped). */
export const INJECT_MAX_CHARS = 800;

/** Least searchable terms the owner message needs, and least of them an episode must share, for a block. */
export const INJECT_MIN_TERMS = 2;

/** A goal closed this long ago (ms) or less, with a failure signal, gets one reflection (older closed goals never do). */
export const REFLECT_WINDOW_MS = 172_800_000;

/** Most goal reflections one memory tick writes (the rest wait for the next tick). */
export const REFLECT_MAX_PER_TICK = 3;

/** Chars of the reflection model input (goal facts from the db); the start is kept (scope and items come first). */
export const REFLECT_INPUT_MAX_CHARS = 8_000;
