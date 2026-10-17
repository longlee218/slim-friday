import { STALE_AFTER_MS } from "../../config/resilience-caps";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { getRole } from "../../roles/role-registry";
import { getItem } from "../../storage/owned-item-store";
import { appendEvent } from "../../storage/thread-event-store";
import type { LeadRuntime } from "../lead/lead-runtime";
import { type LiveRun, liveWorkers } from "../run/live-runs";

/* The watchdog: a worker run with no sign of life (tool start, ReportProgress, run start) for longer than its threshold
   is stuck; it is aborted (cause `stale`) and the lead gets a `timeout` event. A run waiting on the owner or the lead by
   design is never stale. What happens after the abort (auto-resume) is a later phase. */

/** Item statuses that are final: no `timeout` event for them. */
const ENDED = new Set(["completed", "failed", "cancelled"]);

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

/** Threshold of a run: its role's override, else the default. A role name unknown to the registry uses the default. */
function staleAfterOfRole(run: LiveRun): number {
  try {
    return getRole(run.role).staleAfterMs ?? STALE_AFTER_MS;
  } catch {
    return STALE_AFTER_MS;
  }
}

/**
 * One sweep: abort every stale worker run and append one `timeout` event per task and dispatch (the id makes a repeat a
 * no-op), then wake the lead. Returns the aborted runs. Never throws (a db error is logged, the abort still happened).
 */
export function sweepStale(
  rt: LeadRuntime,
  now = Date.now(),
  staleAfterOf: (run: LiveRun) => number = staleAfterOfRole,
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
    try {
      const item = run.taskId ? getItem(rt.deps.db, run.taskId) : undefined;
      // An item that already ended is news to nobody (the run only had not settled yet).
      if (!item || ENDED.has(item.status)) continue;
      appendEvent(rt.deps.db, {
        id: `stale:${item.id}:${item.dispatchCount}`,
        threadId: run.threadId,
        taskId: item.parentId ?? item.id,
        itemId: item.id,
        kind: "timeout",
        payload: { key: item.itemKey, reason: "no activity", idleMinutes },
      });
      rt.announce(run.threadId);
    } catch (err) {
      logEvent(log, "watchdog.event_failed", { taskId: run.taskId, err: errText(err) }, "error");
    }
  }
  return stale;
}
