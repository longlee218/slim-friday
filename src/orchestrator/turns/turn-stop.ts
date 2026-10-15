import type { Database } from "bun:sqlite";
import { type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import { countQueuedProposals } from "../../storage/proposal-store";
import type { LeadQueue } from "../engine/lead-queue";
import { stopThreadTree } from "../engine/stop-thread-tree";

/**
 * `stop` (an orchestrator command, never steer): abort the thread's active run at once. The thread's queued tasks
 * are KEPT: they start, in order, once the stopped run has ended (a stop cancels the running work, not the
 * owner's other requests). The run's input channel closes on that abort (nothing more is yielded). The rest of the
 * thread's tree goes down too: queued lead inputs, every detached task run (rows `cancelled`), unstarted `start` events.
 */
export function stopThread(
  db: Database,
  threadId: string,
  language: OwnerLanguage,
  running?: AbortController,
  leadQueue?: Pick<LeadQueue, "stop">,
): string {
  if (!running) return renderUserNotice({ kind: "stop", active: false }, language);
  running.abort();
  stopThreadTree(db, threadId, leadQueue);
  const queued = countQueuedProposals(db, threadId);
  return renderUserNotice({ kind: "stop", active: true, queued }, language);
}

/** Register a fresh controller as the thread's active one (the queue that runs after a user `/stop`) and return it. */
export function renewActive(
  active: Map<string, AbortController>,
  threadId: string,
): AbortController {
  const fresh = new AbortController();
  active.set(threadId, fresh);
  return fresh;
}
