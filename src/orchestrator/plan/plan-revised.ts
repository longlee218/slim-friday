import type { Database } from "bun:sqlite";
import type { UserNotice } from "../../ingress/user-copy";
import { taskOrigin } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";
import type { PlanDoc } from "./plan-types";

/* What an applied plan revision changed, told to the teammate (a `plan_revised` news event) and the owner (one short line per applied revision, see `revisionNotice`).
   The teammate hears only a revision that cancels work or changes the acceptance criteria. */

/** The diff of one applied revision, by item key. */
export interface RevisionDiff {
  /** The version it replaced. */
  from: number;
  version: number;
  added: string[];
  cancelled: string[];
  modified: string[];
  criteriaChanged: boolean;
  reason: string;
}

/** True when nothing the owner sees changed (no item added, cancelled or modified, same criteria): no line is posted. */
export const isNoop = (d: RevisionDiff): boolean =>
  !d.added.length && !d.cancelled.length && !d.modified.length && !d.criteriaChanged;

/** True when two criteria lists differ. */
export const criteriaDiffer = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify(a) !== JSON.stringify(b);

/**
 * The one diff of two plan versions by item key, for an applied revision and a re-plan alike. Order is ignored; `left`
 * are keys the new version dropped because they completed (not a cancel).
 */
export function diffVersions(
  before: PlanDoc,
  after: PlanDoc,
  v: { from: number; version: number; reason: string; left?: readonly string[] },
): RevisionDiff {
  const old = new Map(before.items.map((i) => [i.key, JSON.stringify(i)]));
  const now = new Map(after.items.map((i) => [i.key, JSON.stringify(i)]));
  return {
    from: v.from,
    version: v.version,
    added: [...now.keys()].filter((k) => !old.has(k)),
    cancelled: [...old.keys()].filter((k) => !now.has(k) && !v.left?.includes(k)),
    modified: [...now].filter(([k, v]) => old.has(k) && old.get(k) !== v).map(([k]) => k),
    criteriaChanged: criteriaDiffer(before.acceptanceCriteria, after.acceptanceCriteria),
    reason: v.reason,
  };
}

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
 * Tell the teammate (`items_added` news, one line) that CODE added items to a PLAN goal's structure: verify-N or fix-N.
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

/** The owner notice of a revision (rendered in the owner's language by `renderUserNotice`): one line, version change and key counts; the viewer link is sent beside it. */
export const revisionNotice = (d: RevisionDiff): UserNotice => ({
  kind: "plan-revised",
  from: d.from,
  to: d.version,
  cancelled: d.cancelled,
  added: d.added,
  modified: d.modified,
  criteriaChanged: d.criteriaChanged,
});
