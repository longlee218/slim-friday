/* Caps of the run layer: the shared pool of agent runs, the wait for a free slot, the worker question wait.
   Plain constants: no env, no behaviour. Lead and plan caps are in `lead-caps.ts`, resilience caps in `resilience-caps.ts`. */

/** Agent runs (lead and worker) that may run in parallel; one SDK query is ~220 MB RSS. No queue: a caller retries when full. */
export const WORKER_POOL_MAX = 30;

/** Wait (ms) before a dispatch pass retries an item the run pool deferred (any worker ending retries earlier). */
export const WORKER_SLOT_RETRY_MS = 3000;

/** Longest wait (ms) of a worker for the lead's or owner's answer to its question; then the ask fails like an owner timeout. */
export const RELAY_WAIT_MS = 30 * 60_000;
