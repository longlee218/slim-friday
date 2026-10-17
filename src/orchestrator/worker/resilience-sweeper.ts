import { SWEEP_TICK_MS } from "../../config/resilience-caps";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import type { LeadRuntime } from "../lead/lead-runtime";
import { sweepItemAge } from "./item-age";
import { sweepStale } from "./watchdog";

/** Logger of this module. */
const log = logger.child({ module: "resilience-sweeper" });

/* One timer for the resilience checks of the live worker runs (the watchdog and the item age limit; the check-in digest joins this tick). */

/** Sweep every tick; the timer never keeps the process alive. Returns the stop function. */
export function startResilienceSweeper(rt: LeadRuntime, tickMs = SWEEP_TICK_MS): () => void {
  const timer = setInterval(() => {
    // A failing sweep (db error) must not crash the process; the next tick tries again.
    try {
      sweepStale(rt);
      sweepItemAge(rt);
    } catch (err) {
      logEvent(log, "sweeper.tick_failed", { err: errText(err) }, "error");
    }
  }, tickMs);
  timer.unref();
  return () => clearInterval(timer);
}
