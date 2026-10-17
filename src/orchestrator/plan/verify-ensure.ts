import type { Database } from "bun:sqlite";

import { excerpt } from "../../observability/logger";
import { childrenOf, type ItemRow, isHeld } from "../../storage/owned-item-store";
import { rewriteNotStartedItem, taskScope } from "../../storage/owned-task-store";
import { moveTaskTo, SCOPE_CHARS } from "../../tasks/task-resolver";
import { FIX_KEY, PLANNER_KEY, VERIFY_KEY, VERIFY_ROLE } from "./plan-types";
import {
  insertItem,
  isVerifyKey,
  isWriter,
  nextNumber,
  numberOf,
  verifyBrief,
} from "./verify-items";

/* Where the verify items of a goal come from. Called at the end of every plan approval (materialize), in its transaction. */

/** Item statuses a verify may still be rewritten in. */
const NOT_STARTED = new Set(["pending", "ready"]);

/**
 * Append or refresh the goal's verify items. Only the LAST wave verifies: while the plan defers scope a not-started verify is
 * cancelled and none is added. Without criteria none at all. One verify item per location that has a writer item (no
 * writer: one, in the last item's location), numbered in one sequence (`verify-1`, `verify-2`...), each waiting for every
 * live item of the goal. For the newest verify of a location:
 * - not started: rewritten in place (new dependencies, brief);
 * - started or ended and this approval created items: a new `verify-(max+1)` (the old one is cancelled when held; a running
 *   one ends on its own and its failure starts no fix loop: see `afterVerify`). The fix cap counts fixes per location, so a
 *   revision never resets it.
 */
export function ensureVerify(
  db: Database,
  a: {
    goalId: string;
    criteria: readonly string[];
    hasDeferred: boolean;
    created: readonly string[];
  },
): void {
  const items = childrenOf(db, a.goalId);
  if (a.hasDeferred) {
    for (const v of items)
      if (isVerifyKey(v.itemKey) && NOT_STARTED.has(v.status)) moveTaskTo(db, v.id, "cancelled");
    return;
  }
  if (!a.criteria.length) return;
  // Everything a verify waits for: plan items and fix items that still count (never planner or verify items).
  const deps = items
    .filter(
      (i) =>
        i.itemKey &&
        !i.itemKey.startsWith(PLANNER_KEY) &&
        !isVerifyKey(i.itemKey) &&
        i.status !== "cancelled",
    )
    .map((i) => i.itemKey as string);
  if (!deps.some((k) => numberOf(k, FIX_KEY) === undefined)) return; // only fix items or none: nothing planned to verify
  const writerAt = [...new Set(items.filter(isWriter).map((i) => i.location as string))];
  const lastAt = items.findLast((i) => i.location && !i.itemKey?.startsWith(PLANNER_KEY))?.location;
  const places: (string | null)[] = writerAt.length ? writerAt : [lastAt ?? null];
  const objective = taskScope(db, a.goalId) ?? "the goal";
  let next = nextNumber(items, VERIFY_KEY);
  for (const location of places) {
    const brief = verifyBrief(
      objective,
      a.criteria,
      location ? { location, shared: places.length > 1 } : undefined,
    );
    const newest = newestVerifyAt(items, location);
    if (!newest) insert(db, a.goalId, `${VERIFY_KEY}-${next++}`, brief, location, deps);
    else if (NOT_STARTED.has(newest.status))
      rewriteNotStartedItem(db, newest.id, {
        brief,
        scope: excerpt(brief, SCOPE_CHARS),
        location,
        dependsOn: deps,
      });
    else if (a.created.length) {
      if (isHeld(newest)) moveTaskTo(db, newest.id, "cancelled"); // replaced: the new verify decides
      insert(db, a.goalId, `${VERIFY_KEY}-${next++}`, brief, location, deps);
    }
  }
}

/** The goal's newest verify item of a location, or undefined. */
function newestVerifyAt(items: readonly ItemRow[], location: string | null): ItemRow | undefined {
  return items
    .filter((i) => isVerifyKey(i.itemKey) && (i.location ?? null) === location)
    .sort((x, y) => (numberOf(x.itemKey, VERIFY_KEY) ?? 0) - (numberOf(y.itemKey, VERIFY_KEY) ?? 0))
    .at(-1);
}

/** Insert one verify item. */
const insert = (
  db: Database,
  goalId: string,
  key: string,
  brief: string,
  location: string | null,
  dependsOn: string[],
): void => insertItem(db, goalId, { key, role: VERIFY_ROLE, brief, location, dependsOn });
