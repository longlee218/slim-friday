import type { Database } from "bun:sqlite";
import { type Route, TASK_BUDGET_USD } from "../../config/model-routing";
import { type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import { childrenOf, type ItemRow } from "../../storage/owned-item-store";
import { costOfTasks, spentByTask } from "../../storage/run-metrics-store";

/* Task and goal budget: what is left of the per-task ceiling `TASK_BUDGET_USD` (declared in config/model-routing.ts, where
   `resolveBudget` turns it into the per-run cap). One goal shares the same figure as its plan cap. */

/** Spend ceiling (USD) of one goal (its plan caps and its items share it): the same figure as the per-task ceiling. */
export const GOAL_BUDGET_USD = TASK_BUDGET_USD;

/**
 * Task ceiling (`TASK_BUDGET_USD`): the run input with `route.spentUsd` = what the task's earlier runs already cost (its
 * own and the runs it resumes), so `resolveBudget` limits this run to what is left. Unchanged
 * when nothing was spent yet.
 */
export function withSpent<T extends { turnId: string; route?: Route }>(db: Database, i: T): T {
  const spentUsd = spentByTask(db, i.turnId);
  return spentUsd > 0 ? { ...i, route: { ...i.route, spentUsd } } : i;
}

/** Owner text when the task ceiling is already used up by the task's earlier runs: the run is refused up front (no 0 budget). */
export const ceilingRefusal = (
  route: Route | undefined,
  language: OwnerLanguage,
): string | undefined =>
  (route?.spentUsd ?? 0) >= TASK_BUDGET_USD
    ? renderUserNotice({ kind: "failure", cause: "ceiling" }, language)
    : undefined;

/** USD the task ceiling still leaves once `spentUsd` is used (negative = over; the supervisor treats it as none). */
export const remainingUsd = (spentUsd: number): number => TASK_BUDGET_USD - spentUsd;

/** Cost (USD) of every run of the goal's items so far (the per-goal share of the task budget). */
export const goalSpent = (db: Database, items: ItemRow[]): number =>
  costOfTasks(
    db,
    items.map((i) => i.id),
  );

/** True when the goal's items already cost the goal budget: its next item is not started. */
export const goalOverBudget = (db: Database, items: ItemRow[]): boolean =>
  goalSpent(db, items) >= GOAL_BUDGET_USD;

/**
 * Route of an item run: `capUsd` = what the goal has left of `GOAL_BUDGET_USD` now, so a run (up to the role budget) can
 * not push the goal past its budget. Runs started in the same pass read the same figure (a known, bounded overshoot).
 */
export const goalRoute = (db: Database, goalId: string): Route => ({
  capUsd: Math.max(0, GOAL_BUDGET_USD - goalSpent(db, childrenOf(db, goalId))),
});
