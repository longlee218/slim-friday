import { WORKER_POOL_MAX } from "../../config/run-caps";

/** A bounded pool of concurrent agent runs (each SDK query is ~220 MB RSS). `tryAcquire` never waits; `acquire` waits FIFO. */
export interface RunLimiter {
  /** Take a slot; returns a release function, or null when the cap is reached. */
  tryAcquire(): (() => void) | null;
  /**
   * Take a slot, waiting FIFO while the pool is full. Resolves null when the waiting bound is reached (nothing queued)
   * or when `signal` aborts (the wait is cancelled).
   */
  acquire(signal?: AbortSignal): Promise<(() => void) | null>;
  /** Number of runs currently holding a slot. */
  active(): number;
  /** Number of callers waiting in `acquire`. */
  waiting(): number;
  /** True when a caller that finds the pool full can still queue (waiting bound not reached). */
  canWait(): boolean;
}

/** Build a limiter allowing at most `max` concurrent runs, and `maxWaiting` queued callers (0 = nobody waits). */
export function createRunLimiter(max: number = WORKER_POOL_MAX, maxWaiting = 0): RunLimiter {
  /** Slots currently taken. */
  let count = 0;
  /** Callers waiting for a slot, oldest first. */
  const waiters: Array<(release: () => void) => void> = [];
  /** A slot holder's release. Idempotent so a double call in a finally block cannot free someone else's slot. */
  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next)
        next(makeRelease()); // hand the slot over: the count stays
      else count--;
    };
  };
  const tryAcquire = (): (() => void) | null => {
    if (count >= max) return null;
    count++;
    return makeRelease();
  };
  return {
    tryAcquire,
    acquire(signal) {
      if (signal?.aborted) return Promise.resolve(null);
      const free = tryAcquire();
      if (free) return Promise.resolve(free);
      if (waiters.length >= maxWaiting) return Promise.resolve(null);
      return new Promise((resolve) => {
        const onAbort = () => {
          const at = waiters.indexOf(grant);
          if (at >= 0) waiters.splice(at, 1);
          resolve(null);
        };
        const grant = (release: () => void) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        };
        waiters.push(grant);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    active: () => count,
    waiting: () => waiters.length,
    canWait: () => waiters.length < maxWaiting,
  };
}
