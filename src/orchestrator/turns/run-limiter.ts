import { WORKER_POOL_MAX } from "../../config/run-caps";

/** Global cap on concurrent agent runs (each SDK query is ~220 MB RSS). No queue: callers reject when full. */
export interface RunLimiter {
  /** Take a slot; returns a release function, or null when the cap is reached. */
  tryAcquire(): (() => void) | null;
  /** Number of runs currently holding a slot. */
  active(): number;
}

/** Build a limiter allowing at most `max` concurrent runs (default: the app's cap). */
export function createRunLimiter(max: number = WORKER_POOL_MAX): RunLimiter {
  /** Slots currently taken. */
  let count = 0;
  return {
    tryAcquire() {
      if (count >= max) return null;
      count++;
      // Release is idempotent so a double call in finally blocks cannot free someone else's slot.
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count--;
      };
    },
    active: () => count,
  };
}
