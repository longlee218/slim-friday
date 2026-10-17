/* Caps of the orchestration resilience layer (watchdog today; auto-resume, check-in and waves add theirs here).
   Plain constants: no env, no behaviour. A role may override the stale threshold with `RoleDefinition.staleAfterMs`. */

/** A worker run with no sign of life for this long (ms) is aborted by the watchdog. Above the SDK's 10 min Bash cap. */
export const STALE_AFTER_MS = 15 * 60_000;

/** How often (ms) the resilience sweeper looks at the live worker runs. Stale is found within the threshold + one tick. */
export const SWEEP_TICK_MS = 60_000;

/** Least gap (ms) between two persisted activity writes of one task (the in-memory stamp is always fresh). */
export const ACTIVITY_PERSIST_MS = 60_000;
