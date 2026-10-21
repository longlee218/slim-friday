/* Limits of the memory jobs (flush after compaction, idle episodes, prune; dreaming adds its own here).
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

/** A thread whose newest lead turn ended this long ago (ms) is idle: it gets an episode. */
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
