import type { Database } from "bun:sqlite";
import { logEvent, logger } from "../../observability/logger";
import { getItem } from "../../storage/owned-item-store";
import { runningTasks, taskScope } from "../../storage/owned-task-store";
import { interruptRunningTurns } from "../../storage/run-store";
import { appendEvent, unclaimStale, undeliveredThreads } from "../../storage/thread-event-store";

/** Logger of this module. */
const log = logger.child({ module: "recover-in-flight" });

/** Longest excerpt (chars) of the last known output carried in the recovery event. */
const EXCERPT_MAX = 600;

/** What the boot recovery did. */
export interface RecoveryReport {
  /** Tasks that were `running` with no process to run them (one `recovered_after_restart` event each). */
  recovered: string[];
  /** Event claims released because their consumer turn is gone. */
  unclaimed: number;
  /** Threads with undelivered events (the lead queue is drained for them when it is on). */
  threads: string[];
}

/**
 * Boot recovery, before Discord starts and before any run exists. Order matters: (1) read the `running` tasks, because
 * (2) interrupting the turns moves them to `waiting_user`; (3) with the turns no longer running, stale event claims
 * are released; (4) each recovered task gets ONE `recovered_after_restart` event (task id + last output excerpt), so the
 * work is announced instead of failing silently. The event id is stable, so a repeated boot appends nothing twice.
 */
export function recoverInFlight(db: Database): RecoveryReport {
  // One transaction: the interrupt and the events commit together (a crash between them loses no event).
  return db.transaction(() => recover(db))();
}

/** The body of `recoverInFlight`, run inside its transaction. */
function recover(db: Database): RecoveryReport {
  const running = runningTasks(db);
  interruptRunningTurns(db); // turns -> interrupted, tasks -> waiting_user, pending approvals cancelled
  const unclaimed = unclaimStale(db);
  const recovered: string[] = [];
  for (const t of running) {
    const item = getItem(db, t.id);
    const scope = taskScope(db, t.id);
    const wrote = appendEvent(db, {
      id: `recovered:${t.id}:${t.version}`,
      threadId: t.threadId,
      taskId: t.id,
      kind: "recovered_after_restart",
      payload: {
        taskId: t.id,
        excerpt: (item?.resultExcerpt ?? scope ?? "").slice(0, EXCERPT_MAX),
      },
    });
    if (wrote) recovered.push(t.id);
  }
  if (recovered.length || unclaimed)
    logEvent(log, "recovery.done", { recovered: recovered.length, unclaimed });
  return { recovered, unclaimed, threads: undeliveredThreads(db) };
}
