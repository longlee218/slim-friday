/* Caps of the orchestration resilience layer (watchdog today; auto-resume, check-in and waves add theirs here).
   Plain constants: no env, no behaviour. */

/** A worker run with no sign of life for this long (ms) is aborted by the watchdog. Above the SDK's 10 min Bash cap. */
export const STALE_AFTER_MS = 15 * 60_000;

/** How often (ms) the resilience sweeper looks at the live worker runs. Stale is found within the threshold + one tick. */
export const SWEEP_TICK_MS = 60_000;

/** Least gap (ms) between two persisted activity writes of one task (the in-memory stamp is always fresh). */
export const ACTIVITY_PERSIST_MS = 60_000;

/** Automatic resumes (same session) of one item after a transient failure, per dispatch; the next failure holds the item. */
export const AUTO_RESUME_CAP = 2;

/** Linear backoff step (ms): resume number N waits `N x` this before it starts (2 s, then 4 s). */
export const RESUME_BACKOFF_STEP_MS = 2000;

/** Circuit breaker: an item dispatched this many times fails instead of starting again (first start + each `RetryTask`; automatic resumes do not count). */
export const MAX_DISPATCHES_PER_ITEM = 3;

/** Age limit (ms) of one goal item: 1 man-day, from its first start (owner wait and backoff count, resumes do not reset it). Past it the item is held for the lead; `RetryTask` starts a fresh window. */
export const ITEM_MAX_AGE_MS = 8 * 60 * 60_000;

/** Least gap (ms) between two check-in digests of one thread (code-rendered, no model); a digest is also skipped while the facts are unchanged. */
export const DIGEST_FLOOR_MS = 30 * 60_000;

/** A held item (blocked + FAILED) with no `RetryTask` / `CancelTask` for this long (ms) wakes the lead once with a `timeout` event. */
export const HOLD_ESCALATE_MS = 30 * 60_000;

/** Most held-item escalations (lead wakes) one sweeper tick writes; the rest fire on the next ticks. */
export const MAX_ESCALATIONS_PER_TICK = 3;

/** Most fix loops of one goal's verify (verify FAILED -> `fix-N` + `verify-(N+1)`); the next failed verify is held for the lead. */
export const MAX_FIX_LOOPS = 2;
