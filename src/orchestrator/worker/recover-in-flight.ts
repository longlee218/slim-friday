import type { Database } from "bun:sqlite";
import { AUTO_RESUME_CAP } from "../../config/resilience-caps";
import { logEvent, logger } from "../../observability/logger";
import {
  bumpAttempt,
  getItem,
  runningGoalItems,
  setResultKind,
  threadsWithReadyItems,
} from "../../storage/owned-item-store";
import { taskScope, threadOfTask } from "../../storage/owned-task-store";
import { interruptRunningTurns } from "../../storage/run-store";
import { runningTasks } from "../../storage/running-owned-task-store";
import { appendEvent, unclaimStale, undeliveredThreads } from "../../storage/thread-event-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import { wavePendingThreads } from "../plan/plan-waves";

/** Logger of this module. */
const log = logger.child({ module: "recover-in-flight" });

/** Longest excerpt (chars) of the last known output carried in the recovery event. */
const EXCERPT_MAX = 600;

/** What the boot recovery did. */
export interface RecoveryReport {
  /** Tasks that were `running` with no process to run them (one `recovered_after_restart` event each). */
  recovered: string[];
  /** Goal items among them that went back to `ready` (same session resumed by the next dispatch pass); the rest of the goal items are held. */
  resumed: string[];
  /** Event claims released because their consumer turn is gone. */
  unclaimed: number;
  /** Threads with undelivered events (the lead queue is drained for them when it is on). */
  threads: string[];
  /** Threads with a goal item in `ready` (boot-resumed, or resumed by the shutdown abort): the dispatch pass runs for them, no lead run. */
  readyThreads: string[];
  /** Threads whose goal finished a wave with deferred scope and no planner yet (a restart hit between the two): the next wave starts. */
  waveThreads: string[];
}

/**
 * Boot recovery, before Discord starts and before any run exists. Order matters: (1) read the `running` tasks, because
 * (2) goal items resume or are held (see `recoverGoalItems`) and interrupting the turns moves the other tasks to `waiting_user`; (3) with the turns no longer running, stale event claims
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
  const resumed = recoverGoalItems(db);
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
        ...(item?.parentId && { autoResumed: resumed.includes(t.id) }),
      },
    });
    if (wrote) recovered.push(t.id);
  }
  if (recovered.length || unclaimed)
    logEvent(log, "recovery.done", { recovered: recovered.length, unclaimed });
  return {
    recovered,
    resumed,
    unclaimed,
    threads: undeliveredThreads(db),
    readyThreads: threadsWithReadyItems(db),
    waveThreads: wavePendingThreads(db),
  };
}

/**
 * Goal items that were `running` when the process died go back to `ready` with `attempt + 1` (the next dispatch pass
 * resumes their session), unless the automatic resumes are used up: then the item is held (`blocked`, result FAILED) with
 * a `failure` event for the lead. Returns the ids that will resume. Runs before the turns are interrupted.
 */
function recoverGoalItems(db: Database): string[] {
  const resumed: string[] = [];
  for (const it of runningGoalItems(db)) {
    if (it.attempt < AUTO_RESUME_CAP && moveTaskTo(db, it.id, "ready")) {
      bumpAttempt(db, it.id);
      resumed.push(it.id);
    } else if (moveTaskTo(db, it.id, "blocked")) {
      setResultKind(db, it.id, "FAILED");
      appendEvent(db, {
        id: `failure:boot:${it.id}:${it.attempt}`,
        threadId: threadOfTask(db, it.id) ?? "",
        taskId: it.parentId ?? it.id,
        itemId: it.id,
        kind: "failure",
        payload: {
          key: it.itemKey,
          status: "blocked",
          class: "real",
          cause: "resume_cap:crash",
          attempt: it.attempt,
        },
      });
    }
  }
  return resumed;
}
