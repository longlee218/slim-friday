import type { Database } from "bun:sqlite";
import { childrenOf, type ItemRow } from "../../storage/owned-item-store";
import { hasPendingPlan } from "../../storage/work-plan-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import { cancelSet } from "../goal/effect-port-queries";
import { supersededVerifyIds } from "../plan/verify-items";

/* Goal bookkeeping: items that can never run are cancelled, a goal whose items all ended gets its final status. */

/** Item statuses that ended for good. */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Cancel every item that waits (transitively) for `itemId`: it failed, so they can never start. */
export function cancelDependents(db: Database, itemId: string): void {
  for (const id of cancelSet(db, itemId)) if (id !== itemId) moveTaskTo(db, id, "cancelled");
}

/**
 * When every item of the goal ended, settle the goal row: all completed = `completed`, any failed = `failed`, else
 * `cancelled`; a verify that a newer verify replaced is left out (the newest verify decides). (A goal row starts `open`; the state machine has no `open -> completed`, so it passes through `running`.)
 * Returns the items read.
 */
export function settleGoal(db: Database, goalId: string): ItemRow[] {
  const items = childrenOf(db, goalId);
  if (!items.length || !items.every((i) => TERMINAL.has(i.status))) return items;
  if (hasPendingPlan(db, goalId)) return items; // the planner ended, the plan waits for the owner: the goal goes on
  const old = supersededVerifyIds(items);
  const deciding = items.filter((i) => !old.has(i.id));
  const final = deciding.every((i) => i.status === "completed")
    ? "completed"
    : deciding.some((i) => i.status === "failed")
      ? "failed"
      : "cancelled";
  if (final === "cancelled") moveTaskTo(db, goalId, "cancelled");
  else if (moveTaskTo(db, goalId, "running")) moveTaskTo(db, goalId, final);
  return items;
}
