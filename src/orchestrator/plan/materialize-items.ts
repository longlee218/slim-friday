import type { Database } from "bun:sqlite";

import { excerpt } from "../../observability/logger";
import { rewriteNotStartedItem } from "../../storage/item-edit-store";
import { childrenOf, type ItemRow } from "../../storage/owned-item-store";
import { insertOwnedTask, taskOrigin } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";
import { moveTaskTo, SCOPE_CHARS } from "../../tasks/task-resolver";
import { cancelSet } from "../goal/effect-port-queries";
import { runOfTask } from "../run/live-runs";
import { recordRevision } from "./plan-revised";
import type { PlanDoc, PlanItem } from "./plan-types";
import { ensureVerify } from "./verify-ensure";

/* Plan items to owned tasks. Idempotent by goal + key: an item that exists is never created twice, so applying the same
   approved version again changes nothing. Dispatch-ready then runs them (sequential, topo order, in L2). */

/** Item statuses a revision may still change (not started). */
const NOT_STARTED = new Set(["pending", "ready"]);
/** Item statuses that ended for good. */
const ENDED = new Set(["completed", "failed", "cancelled"]);

/** Plan items in dependency order (a dependency before its dependents; the plan was validated acyclic). */
function topoOrder(items: readonly PlanItem[]): PlanItem[] {
  const out: PlanItem[] = [];
  const done = new Set<string>();
  const own = new Set(items.map((i) => i.key));
  for (let left = [...items]; left.length; ) {
    const ready = left.filter((i) => i.dependsOn.every((d) => !own.has(d) || done.has(d)));
    if (!ready.length) return [...out, ...left]; // unreachable for a valid plan; never loop forever
    for (const i of ready) {
      out.push(i);
      done.add(i.key);
    }
    left = left.filter((i) => !done.has(i.key));
  }
  return out;
}

/** What `materialize` did, by item key. */
export interface Applied {
  created: string[];
  modified: string[];
  cancelled: string[];
}

/**
 * Apply a plan version to the goal's items, in the caller's transaction.
 * - an item key the goal has not: a new task (`ready`, or `pending` when it waits) and one `start` event;
 * - an item that exists and has not started: brief, location and dependencies follow the plan;
 * - `cancelKeys`: those items are cancelled (a running one is aborted after the commit by the caller via `abort`);
 * - `releaseBlocked` (first approval): items that reported NEEDS_PLANNING are cancelled, the plan replaces them. A plan
 *   item that waited for a released item stops waiting for it (validation refuses that; this is a safety net); any other
 *   item that waited for it is cancelled too. One `plan_revised` event tells the teammate when either happened.
 */
export function materialize(
  db: Database,
  o: {
    goalId: string;
    planId: string;
    version: number;
    doc: PlanDoc;
    cancelKeys: readonly string[];
    releaseBlocked: boolean;
  },
): Applied & { abort: string[] } {
  const goal = taskOrigin(db, o.goalId);
  if (!goal) throw new Error(`goal ${o.goalId} missing`);
  const have = new Map(childrenOf(db, o.goalId).map((i) => [i.itemKey, i] as const));
  const out: Applied & { abort: string[] } = {
    created: [],
    modified: [],
    cancelled: [],
    abort: [],
  };
  // Items the plan replaces (reported NEEDS_PLANNING, first approval): their keys leave the plan items' dependencies.
  const released = [...have.values()].filter(
    (i) => o.releaseBlocked && i.status === "blocked" && i.resultKind === "NEEDS_PLANNING",
  );
  const gone = new Set(released.map((i) => i.itemKey));
  // Plan items that stopped waiting for a released item. Validation refuses such a dependency, so this is a safety net
  // (the item was running when the plan was stored, then reported NEEDS_PLANNING): it is told to the teammate.
  const repointed: string[] = [];
  for (const planned of topoOrder(o.doc.items)) {
    const it = { ...planned, dependsOn: planned.dependsOn.filter((k) => !gone.has(k)) };
    if (it.dependsOn.length !== planned.dependsOn.length) repointed.push(it.key);
    const cur = have.get(it.key);
    if (!cur) {
      const id = crypto.randomUUID();
      insertOwnedTask(db, {
        id,
        threadId: goal.threadId,
        ownerRole: it.role,
        status: it.dependsOn.length ? "pending" : "ready",
        scope: excerpt(it.brief, SCOPE_CHARS),
        correlationId: goal.correlationId,
        parentId: o.goalId,
        itemKey: it.key,
        dependsOn: it.dependsOn,
        brief: it.brief,
        subject: it.subject,
        priority: it.priority ?? 0,
        ...(it.location && { location: it.location }),
      });
      appendEvent(db, {
        id: `plan:${o.planId}:${it.key}`,
        threadId: goal.threadId,
        taskId: o.goalId,
        itemId: id,
        kind: "start",
        correlationId: goal.correlationId,
        payload: {
          key: it.key,
          role: it.role,
          strategy: "PLAN",
          planVersion: o.version,
          plan: true, // owner-approved: not counted in the chain cap (see goalCaps)
          by: "teammate",
        },
      });
      out.created.push(it.key);
    } else if (NOT_STARTED.has(cur.status) && changed(cur, it)) {
      rewriteNotStartedItem(db, cur.id, {
        brief: it.brief,
        scope: excerpt(it.brief, SCOPE_CHARS),
        location: it.location ?? null,
        dependsOn: it.dependsOn,
        subject: it.subject,
        priority: it.priority ?? 0,
      });
      out.modified.push(it.key);
    }
  }
  const doomed = [...have.values()].filter(
    (i) =>
      !ENDED.has(i.status) &&
      ((i.itemKey !== null && o.cancelKeys.includes(i.itemKey)) || released.includes(i)),
  );
  for (const d of doomed) {
    if (moveTaskTo(db, d.id, "cancelled")) {
      out.cancelled.push(d.itemKey ?? d.id);
      out.abort.push(d.id);
    }
  }
  // Items still waiting for a released item (not plan items: those were re-pointed above) could never start.
  const orphans = released
    .flatMap((r) => cancelSet(db, r.id))
    .filter((id) => !released.some((r) => r.id === id));
  let orphansCancelled = 0;
  for (const id of new Set(orphans)) {
    const row = childrenOf(db, o.goalId).find((i) => i.id === id);
    if (row && !ENDED.has(row.status) && moveTaskTo(db, id, "cancelled")) {
      out.cancelled.push(row.itemKey ?? id);
      out.abort.push(id);
      orphansCancelled++;
    }
  }
  // Told only when something moved: waiting items were cancelled, or plan items were re-pointed.
  if (orphansCancelled || repointed.length)
    recordRevision(db, o.goalId, o.planId, {
      from: o.version - 1, // teammate news only: the owner is not told of this one
      version: o.version,
      added: out.created,
      cancelled: out.cancelled,
      modified: out.modified,
      criteriaChanged: false,
      reason: [
        "the plan replaces the items that reported NEEDS_PLANNING",
        ...(orphansCancelled ? ["the items waiting for them were cancelled"] : []),
        ...(repointed.length
          ? [`plan items no longer wait for them: ${repointed.join(", ")}`]
          : []),
      ].join("; "),
    });
  // The verify item goes in last: it waits for every live item, the ones this version just created included.
  ensureVerify(db, {
    goalId: o.goalId,
    criteria: o.doc.acceptanceCriteria,
    created: out.created,
  });
  return out;
}

/** Abort the live runs of cancelled items (after the transaction committed). */
export const abortRuns = (ids: readonly string[]): void => {
  for (const id of ids) runOfTask(id)?.ac.abort();
};

/** True when the stored item differs from the plan item in what a worker would see. */
const changed = (cur: ItemRow, it: PlanItem): boolean =>
  cur.brief !== it.brief ||
  cur.subject !== it.subject ||
  cur.priority !== (it.priority ?? 0) ||
  (cur.location ?? undefined) !== it.location ||
  JSON.stringify(cur.dependsOn) !== JSON.stringify(it.dependsOn);
