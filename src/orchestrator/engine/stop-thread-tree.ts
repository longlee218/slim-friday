import type { Database } from "bun:sqlite";
import { logEvent, logger, tryLog } from "../../observability/logger";
import { childrenOf } from "../../storage/owned-item-store";
import { cancelStartEvents } from "../../storage/thread-event-store";
import { closePendingPlans } from "../../storage/work-plan-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import { abortThreadRuns } from "../run/live-runs";
import { openGoalIdOf } from "./effect-port-queries";
import { settleGoal } from "./goal-settle";
import type { LeadQueue } from "./lead-queue";

/** Logger of this module. */
const log = logger.child({ module: "stop-thread-tree" });

/**
 * `/stop` of a whole thread: drop the queued lead inputs, abort the lead run and every worker run of the thread, move the
 * live tasks to `cancelled` (CAS: a task that already ended keeps its status) and close the goal's pending plan versions
 * (`draft` / `valid`) and the undelivered `start` events as cancelled. Never throws. Returns the aborted task ids.
 */
export function stopThreadTree(
  db: Database,
  threadId: string,
  leadQueue?: Pick<LeadQueue, "stop">,
): string[] {
  leadQueue?.stop(threadId);
  const runs = abortThreadRuns(threadId); // lead + workers
  const aborted = runs.flatMap((h) => (h.taskId ? [h.taskId] : []));
  tryLog(log, "stop tree rows failed", () => {
    // `moveTaskTo` is a CAS and refuses a move out of a terminal state: an ended task keeps its status.
    const goalId = openGoalIdOf(db, threadId); // read before the cancels: an all-ended goal no longer reads as open
    for (const id of aborted) moveTaskTo(db, id, "cancelled");
    // Items of the open goal that never started (`pending` / `ready`) would start on the next dispatch pass: cancel them too.
    if (goalId) {
      for (const it of childrenOf(db, goalId))
        if (it.status === "pending" || it.status === "ready") moveTaskTo(db, it.id, "cancelled");
      closePendingPlans(db, goalId, "stopped"); // a later "approve" of the open plan question must create nothing
      settleGoal(db, goalId);
    }
    cancelStartEvents(db, threadId);
  });
  if (aborted.length) logEvent(log, "stop.tree", { threadId, tasks: aborted.length });
  return aborted;
}
