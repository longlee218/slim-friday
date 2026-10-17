import { SWEEP_TICK_MS } from "../../config/resilience-caps";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import type { LeadRuntime } from "../lead/lead-runtime";
import { createCheckIn } from "./check-in";
import { sweepItemAge } from "./item-age";
import { sweepStale } from "./watchdog";

/** Logger of this module. */
const log = logger.child({ module: "resilience-sweeper" });

/* One timer for the resilience checks of the live worker runs (the watchdog, the item age limit and the check-in digest). */

/** Sweep every tick; the timer never keeps the process alive. Returns the stop function. */
export function startResilienceSweeper(rt: LeadRuntime, tickMs = SWEEP_TICK_MS): () => void {
  const checkIn = createCheckIn();
  const timer = setInterval(() => {
    // Each step has its own guard: a throw in one (db error) must not skip the others; the next tick tries again.
    const step = (name: string, fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        logEvent(log, "sweeper.tick_failed", { step: name, err: errText(err) }, "error");
      }
    };
    step("stale", () => sweepStale(rt));
    step("item_age", () => sweepItemAge(rt));
    step("check_in", () => void checkIn(rt)); // async and never rejects: it logs its own failures
  }, tickMs);
  timer.unref();
  return () => clearInterval(timer);
}
