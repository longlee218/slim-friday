import type { Database } from "bun:sqlite";
import { cancelledByCancelEvents } from "../../storage/cancel-event-store";
import type { ItemRow } from "../../storage/owned-item-store";
import { newestApprovedVersion } from "../../storage/work-plan-store";
import { docOfRow } from "./plan-doc";
import { isReservedKey } from "./plan-types";

/**
 * Ids of the goal's cancelled items that plan mechanics cancelled: a key the newest approved plan does not hold (a
 * revision dropped it, or the plan replaced an item that reported NEEDS_PLANNING). Planner, verify and fix items are
 * never counted, nor is an item a `cancel` event names (the lead or owner stopped that work: it counts). Such a cancel
 * is no failure of the plan: `settleGoal` leaves them out of the goal's outcome.
 */
export function planDroppedIds(
  db: Database,
  goalId: string,
  items: readonly ItemRow[],
): Set<string> {
  const plan = newestApprovedVersion(db, goalId);
  if (!plan) return new Set();
  const kept = new Set(docOfRow(plan).items.map((i) => i.key));
  const byCancel = cancelledByCancelEvents(db, goalId);
  return new Set(
    items
      .filter(
        (i) =>
          i.status === "cancelled" &&
          i.itemKey &&
          !isReservedKey(i.itemKey) &&
          !kept.has(i.itemKey) &&
          !byCancel.has(i.id),
      )
      .map((i) => i.id),
  );
}
