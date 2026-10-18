import { ABORT_GRACE_MS } from "../../config/resilience-caps";
import { logEvent, logger } from "../../observability/logger";
import { type LiveRun, liveWorkers } from "../run/live-runs";

/* The reaper: a worker run that was aborted but never exits (an SDK or tool call that ignores the abort) would hold its
   slot, its location and its goal forever (the watchdog and the age limit both skip an aborted run). After
   `ABORT_GRACE_MS` it is force-closed: the run's own crash path holds the item with a `failure` event. */

/** Logger of this module. */
const log = logger.child({ module: "abort-reaper" });

/** When a sweep first saw each run aborted (the abort itself is not stamped: owner `/stop` and shutdown abort directly). */
const firstSeenAborted = new WeakMap<LiveRun, number>();

/** One sweep at `now`: force-close every worker run aborted for more than `graceMs`. Returns the reaped runs. */
export function reapAborted(now = Date.now(), graceMs = ABORT_GRACE_MS): LiveRun[] {
  const reaped: LiveRun[] = [];
  for (const run of liveWorkers()) {
    if (!run.ac.signal.aborted) continue;
    const since = firstSeenAborted.get(run) ?? now;
    firstSeenAborted.set(run, since);
    if (now - since < graceMs) continue;
    logEvent(
      log,
      "reaper.force_close",
      { taskId: run.taskId, threadId: run.threadId, role: run.role, graceMs },
      "warn",
    );
    run.forceClose?.();
    reaped.push(run);
  }
  return reaped;
}
