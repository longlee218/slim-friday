/* Caps of the run layer: the shared pool of agent runs, the wait for a free slot, the worker question wait.
   Plain constants: no env, no behaviour. Lead and plan caps are in `lead-caps.ts`, resilience caps in `resilience-caps.ts`. */

/** Worker runs that may run in parallel (RAM: a claude process is 140-464 MB; with the lead pool the bot budget is ~5 GB). A ready item that finds the pool full waits. */
export const WORKER_POOL_MAX = 10;

/** Lead runs that may run in parallel; lead runs take no worker slot. */
export const LEAD_POOL_MAX = 5;

/** Threads that may wait for a lead slot; past it an owner input is refused with a `queue full` notice. */
export const LEAD_WAITING_MAX = 50;

/** A ready item deferred by a full worker pool for this long (ms) is shown to the lead once (`slot_wait` event). */
export const WORKER_SLOT_NOTICE_MS = 60_000;

/** Wait (ms) before a dispatch pass retries an item the run pool deferred (any worker ending retries earlier). */
export const WORKER_SLOT_RETRY_MS = 3000;

/** Longest wait (ms) of a worker for the lead's or owner's answer to its question; then the ask fails like an owner timeout. */
export const RELAY_WAIT_MS = 2 * 60 * 60_000;
