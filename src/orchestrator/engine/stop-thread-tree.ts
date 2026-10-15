import type { Database } from "bun:sqlite";
import { logEvent, logger, tryLog } from "../../observability/logger";
import { moveTaskTo } from "../../tasks/task-resolver";
import { cancelStartEvents } from "../events/event-store";
import type { LeadQueue } from "./lead-queue";
import { abortThreadTasks } from "./task-runs";

/** Logger of this module. */
const log = logger.child({ module: "stop-thread-tree" });

/**
 * `/stop` below the thread's own run: drop the queued lead inputs, abort every task run of the thread, move the
 * live tasks to `cancelled` (CAS: a task that already ended keeps its status) and close the undelivered `start`
 * events as cancelled. The foreground (lead) run is aborted by the caller. Never throws. Returns the aborted task ids.
 */
export function stopThreadTree(
  db: Database,
  threadId: string,
  leadQueue?: Pick<LeadQueue, "stop">,
): string[] {
  leadQueue?.stop(threadId);
  const aborted = abortThreadTasks(threadId);
  tryLog(log, "stop tree rows failed", () => {
    // `moveTaskTo` is a CAS and refuses a move out of a terminal state: an ended task keeps its status.
    for (const h of aborted) moveTaskTo(db, h.taskId, "cancelled");
    cancelStartEvents(db, threadId);
  });
  if (aborted.length) logEvent(log, "stop.tree", { threadId, tasks: aborted.length });
  return aborted.map((h) => h.taskId);
}
