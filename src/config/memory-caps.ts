/* Limits of the memory jobs (flush after compaction today; episodes, dreaming and prune add theirs here).
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
