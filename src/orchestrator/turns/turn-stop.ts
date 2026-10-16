import type { Database } from "bun:sqlite";
import { type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import type { LeadQueue } from "../lead/lead-queue";
import { liveRunOf } from "../run/live-runs";
import { stopThreadTree } from "../run/stop-thread-tree";

/**
 * `stop` (an orchestrator command, never steer): abort the thread's lead run and every worker run at once. The thread's queued tasks
 * are KEPT: they start, in order, once the stopped run has ended (a stop cancels the running work, not the
 * owner's other requests). The run's input channel closes on that abort (nothing more is yielded). The rest of the
 * thread's tree goes down too: queued lead inputs, every detached task run (rows `cancelled`), unstarted `start` events.
 */
export function stopThread(
  db: Database,
  threadId: string,
  language: OwnerLanguage,
  leadQueue?: Pick<LeadQueue, "stop" | "busy">,
): string {
  // A queued or debouncing lead input counts as work too: it is dropped below.
  if (!liveRunOf(threadId) && !leadQueue?.busy(threadId))
    return renderUserNotice({ kind: "stop", active: false }, language);
  stopThreadTree(db, threadId, leadQueue);
  return renderUserNotice({ kind: "stop", active: true }, language);
}
