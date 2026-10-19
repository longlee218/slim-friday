import type { Database } from "bun:sqlite";
import { clearSettledQuestionLinks } from "../../storage/item-question-store";
import { childrenOf, type ItemRow } from "../../storage/owned-item-store";
import { getOwnedTask, taskOrigin } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";
import { hasPendingPlan } from "../../storage/work-plan-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import { cancelSet } from "../goal/effect-port-queries";
import { planDroppedIds } from "../plan/plan-dropped";
import { noteWaveHold, waveOutlook } from "../plan/plan-waves";
import { supersededVerifyIds } from "../plan/verify-items";

/* Goal bookkeeping: items that can never run are cancelled, a goal whose items all ended gets its final status. */

/** Item statuses that ended for good. */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Cancel every item that waits (transitively) for `itemId`: it failed, so they can never start. */
export function cancelDependents(db: Database, itemId: string): void {
  for (const id of cancelSet(db, itemId)) if (id !== itemId) moveTaskTo(db, id, "cancelled");
}

/**
 * Cancel every `pending` item that waits for a dependency which ended `failed` or `cancelled`: it can never start (a plan
 * released or dropped the dependency, or a cancel did not cascade). One `failure` event per item tells the lead.
 * Returns the keys cancelled.
 */
export function cancelDeadWaiters(db: Database, goalId: string): string[] {
  const out: string[] = [];
  const goal = taskOrigin(db, goalId);
  for (let moved = true; moved; ) {
    moved = false;
    const items = childrenOf(db, goalId);
    for (const it of items) {
      if (it.status !== "pending") continue;
      const dead = it.dependsOn.find((k) => {
        const s = items.find((x) => x.itemKey === k)?.status;
        return s === "failed" || s === "cancelled";
      });
      if (dead === undefined || !moveTaskTo(db, it.id, "cancelled")) continue;
      moved = true;
      out.push(it.itemKey ?? it.id);
      if (goal)
        appendEvent(db, {
          id: `dead_dependency:${it.id}`,
          threadId: goal.threadId,
          taskId: goalId,
          itemId: it.id,
          kind: "failure",
          payload: {
            key: it.itemKey,
            status: "cancelled",
            code: "DEAD_DEPENDENCY",
            error: `It waited for ${dead}, which ended without a result: cancelled, it could never start.`,
          },
        });
    }
  }
  return out;
}

/**
 * When every item of the goal ended, settle the goal row: all completed = `completed`, any failed = `failed`, else
 * `cancelled`; a verify that a newer verify of the same location replaced is left out (the newest verify of each location
 * decides), and so is an item the plan cancelled by itself (dropped by a revision, replaced after NEEDS_PLANNING). While the approved plan still defers scope the goal does not settle: the next wave is due (`ready`), or the
 * wave cap was hit (`capped`) or the wave planner left no approved revision (`stalled`): one `failure` event tells the lead, the goal is held. (A goal row starts `open`; the state machine has no `open -> completed`, so it passes through `running`.)
 * Returns the items read.
 */
export function settleGoal(db: Database, goalId: string): ItemRow[] {
  clearSettledQuestionLinks(db, goalId); // an ended item is never answered again: its question links go
  const items = childrenOf(db, goalId);
  if (!items.length || !items.every((i) => TERMINAL.has(i.status))) return items;
  if (hasPendingPlan(db, goalId)) return items; // the planner ended, the plan waits for the owner: the goal goes on
  if (getOwnedTask(db, goalId)?.status !== "open") return items; // closed already (stopped, cancelled)
  const wave = waveOutlook(db, goalId);
  if (wave === "capped" || wave === "stalled") noteWaveHold(db, goalId, wave);
  if (wave === "ready" || wave === "capped" || wave === "stalled") return items;
  // Left out of the outcome: verifies a newer verify replaced, and items plan mechanics cancelled (a revision dropped them).
  const old = supersededVerifyIds(items);
  const dropped = planDroppedIds(db, goalId, items);
  const deciding = items.filter((i) => !old.has(i.id) && !dropped.has(i.id));
  const final = deciding.every((i) => i.status === "completed")
    ? "completed"
    : deciding.some((i) => i.status === "failed")
      ? "failed"
      : "cancelled";
  if (final === "cancelled") moveTaskTo(db, goalId, "cancelled");
  else if (moveTaskTo(db, goalId, "running")) moveTaskTo(db, goalId, final);
  return items;
}
