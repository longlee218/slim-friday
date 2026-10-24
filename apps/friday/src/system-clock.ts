import type { Clock } from "@friday/core";

/** The real clock: wall time and `setTimeout`. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(ms, fn) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};
