import { STALE_AFTER_MS } from "../../config/resilience-caps";
import { logEvent, logger } from "../../observability/logger";
import type { LeadRuntime } from "../lead/lead-runtime";
import { type LiveRun, liveWorkers } from "../run/live-runs";

/* The watchdog: a worker run with no sign of life (tool start, Report progress, run start) for longer than its threshold
   is stuck; it is aborted (cause `stale`). A run waiting on the owner or the lead by
   design is never stale. The failure policy (failure-policy.ts) reads the abort as a transient failure: the item resumes. */

/** Logger of this module. */
const log = logger.child({ module: "watchdog" });

/**
 * Pure: the runs that are stale at `now`. Only worker runs count (never the lead's); a waiting run and a run already
 * aborted (by anyone) are skipped. `staleAfterOf` gives the threshold (ms) of a run.
 */
export function pickStale(
  runs: readonly LiveRun[],
  now: number,
  staleAfterOf: (run: LiveRun) => number,
): LiveRun[] {
  return runs.filter(
    (r) =>
      r.kind === "worker" &&
      (r.waitingCount ?? 0) === 0 &&
      !r.abortCause &&
      !r.ac.signal.aborted && // already stopped (owner /stop, shutdown, replaced): nothing left to abort or report
      now - r.lastActivityAt > staleAfterOf(r),
  );
}

/** Threshold of a run: the same `STALE_AFTER_MS` for every role. */
const staleAfterAny = (): number => STALE_AFTER_MS;

/**
 * One sweep: abort every stale worker run (cause `stale`). No event here: the failure policy resumes the item (the lead does
 * nothing) and, only when the resumes are used up, the held item's `failure` event tells the lead. Returns the aborted runs.
 */
export function sweepStale(
  _rt: LeadRuntime, // kept for the sweeper's call shape

  now = Date.now(),
  staleAfterOf: (run: LiveRun) => number = staleAfterAny,
): LiveRun[] {
  const stale = pickStale(liveWorkers(), now, staleAfterOf);
  for (const run of stale) {
    run.abortCause = "stale"; // before the abort: the run's end reads the cause
    run.ac.abort();
    const idleMinutes = Math.round((now - run.lastActivityAt) / 60_000);
    logEvent(
      log,
      "watchdog.stale",
      { taskId: run.taskId, threadId: run.threadId, role: run.role, idleMinutes },
      "warn",
    );
  }
  return stale;
}
