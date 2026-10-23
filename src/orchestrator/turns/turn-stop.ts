import type { Database } from "bun:sqlite";
import { type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import { liveRunOf } from "../run/live-runs";
import { stopThreadTree } from "../run/stop-thread-tree";
import type { TeammateQueue } from "../teammate/teammate-queue";

/**
 * `stop` (an orchestrator command, never steer): abort the thread's teammate run and every worker run at once. The thread's queued tasks
 * are KEPT: they start, in order, once the stopped run has ended (a stop cancels the running work, not the
 * owner's other requests). The run's input channel closes on that abort (nothing more is yielded). The rest of the
 * thread's tree goes down too: queued teammate inputs, every detached task run (rows `cancelled`), unstarted `start` events.
 */
export function stopThread(
  db: Database,
  threadId: string,
  language: OwnerLanguage,
  teammateQueue?: Pick<TeammateQueue, "stop" | "busy">,
): string {
  // A queued or debouncing teammate input counts as work too: it is dropped below.
  if (!liveRunOf(threadId) && !teammateQueue?.busy(threadId))
    return renderUserNotice({ kind: "stop", active: false }, language);
  stopThreadTree(db, threadId, teammateQueue);
  return renderUserNotice({ kind: "stop", active: true }, language);
}
