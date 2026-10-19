import type { Database } from "bun:sqlite";
import type { UserNotice } from "../../ingress/user-copy";
import { clip, redactText } from "../../observability/redact";
import { taskOrigin } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";

/* What an applied plan revision changed, told to the lead (a `plan_revised` news event) and the owner (one short post, see `revisionNotice`).
   A revision that only adds or activates items is routine and silent; one that cancels work or changes the acceptance
   criteria is applied at once and then announced, so nothing the owner agreed to changes unseen. */

/** The diff of one applied revision, by item key. */
export interface RevisionDiff {
  version: number;
  added: string[];
  cancelled: string[];
  modified: string[];
  criteriaChanged: boolean;
  reason: string;
}

/** Chars of the reason shown to the owner. */
const REASON_CHARS = 300;

/** True when the owner and the lead must hear of the revision (it cancelled work or changed the criteria). */
export const isNoteworthy = (d: RevisionDiff): boolean =>
  d.cancelled.length > 0 || d.criteriaChanged;

/** True when two criteria lists differ. */
export const criteriaDiffer = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify(a) !== JSON.stringify(b);

/** Append the `plan_revised` event of a goal (id per plan version: written once). Returns false when it already existed. */
export function recordRevision(
  db: Database,
  goalId: string,
  planId: string,
  d: RevisionDiff,
): boolean {
  const goal = taskOrigin(db, goalId);
  if (!goal) return false;
  return appendEvent(db, {
    id: `plan_revised:${planId}:${d.version}`,
    threadId: goal.threadId,
    taskId: goalId,
    kind: "plan_revised",
    correlationId: goal.correlationId,
    payload: d,
  });
}

/**
 * Tell the lead (`items_added` news, one line) that CODE added items to a PLAN goal's structure: verify-N, fix-N or a wave's planner-N.
 * One event per insertion batch; the id is stable per key set, so a repeated pass writes it once.
 */
export function recordCodeItems(db: Database, goalId: string, keys: string[], why: string): void {
  const goal = taskOrigin(db, goalId);
  if (!goal || !keys.length) return;
  appendEvent(db, {
    id: `code_items:${goalId}:${keys.join("+")}`,
    threadId: goal.threadId,
    taskId: goalId,
    kind: "items_added",
    correlationId: goal.correlationId,
    payload: { added: keys, reason: why },
  });
}

/** The owner notice of a revision (rendered in the owner's language by `renderUserNotice`): keys and a clipped, redacted reason. */
export const revisionNotice = (d: RevisionDiff): UserNotice => ({
  kind: "plan-revised",
  cancelled: d.cancelled,
  added: d.added,
  modified: d.modified,
  criteriaChanged: d.criteriaChanged,
  reason: clip(redactText(d.reason), REASON_CHARS),
});
