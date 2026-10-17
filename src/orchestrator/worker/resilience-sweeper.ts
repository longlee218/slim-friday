import { SWEEP_TICK_MS } from "../../config/resilience-caps";
import type { LeadRuntime } from "../lead/lead-runtime";
import { sweepStale } from "./watchdog";

/* One timer for the resilience checks of the live worker runs (today the watchdog; the check-in digest joins this tick). */

/** Sweep every tick; the timer never keeps the process alive. Returns the stop function. */
export function startResilienceSweeper(rt: LeadRuntime, tickMs = SWEEP_TICK_MS): () => void {
  const timer = setInterval(() => sweepStale(rt), tickMs);
  timer.unref();
  return () => clearInterval(timer);
}
