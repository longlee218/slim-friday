import type { Database } from "bun:sqlite";
import { PLAN_GOAL_BUDGET_MAX_USD, type Route, TASK_BUDGET_USD } from "../../config/model-routing";
import { type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import {
  ORCHESTRATE_ACTION_CANCEL,
  ORCHESTRATE_ACTION_RETRY,
  orchestrateRef,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { childrenOf, type ItemRow } from "../../storage/owned-item-store";
import { costOfTasks, spentByTask } from "../../storage/run-metrics-store";
import { newestApprovedVersion } from "../../storage/work-plan-store";

/* Task and goal budget: what is left of the per-task ceiling `TASK_BUDGET_USD` (declared in config/model-routing.ts, where
   `resolveBudget` turns it into the per-run cap). A goal's own figure is `goalBudgetOf`. */

/** Spend ceiling (USD) of a goal that has no approved plan (a DELEGATE goal): the same figure as the per-task ceiling. */
export const GOAL_BUDGET_USD = TASK_BUDGET_USD;

/**
 * The ONE budget figure of a goal (USD): its newest approved plan's `budgetUsd`, never above `PLAN_GOAL_BUDGET_MAX_USD`;
 * a goal without an approved plan (DELEGATE, or a plan still waiting) gets `GOAL_BUDGET_USD`. The dispatch pass, the goal-left
 * run cap, the verify loop and the digest all read it here.
 */
export function goalBudgetOf(db: Database, goalId: string): number {
  const planned = newestApprovedVersion(db, goalId)?.budgetUsd;
  return planned != null ? Math.min(planned, PLAN_GOAL_BUDGET_MAX_USD) : GOAL_BUDGET_USD;
}

/**
 * True when the goal's budget can still rise: it has an approved plan whose budget is below the plan ceiling (a revised plan the
 * owner approves may carry a higher one). A goal without a plan (DELEGATE) or at the ceiling is fixed: a held item cannot be retried.
 */
export const goalBudgetCanGrow = (db: Database, goalId: string): boolean =>
  newestApprovedVersion(db, goalId) != null && goalBudgetOf(db, goalId) < PLAN_GOAL_BUDGET_MAX_USD;

/** Why an item was held for budget: the teammate reads it in the `budget_hit` event, so it names the way out. */
export const budgetReason = (db: Database, goalId: string): string =>
  `goal budget $${goalBudgetOf(db, goalId)} used` +
  (goalBudgetCanGrow(db, goalId)
    ? `: ${orchestrateRef(ORCHESTRATE_ACTION_RETRY)} works only after the owner approves a plan revision with a higher budget; else ${orchestrateRef(ORCHESTRATE_ACTION_CANCEL)}`
    : `: it cannot grow (no approved plan, or at the ceiling), so ${orchestrateRef(ORCHESTRATE_ACTION_RETRY)} is refused; ${orchestrateRef(ORCHESTRATE_ACTION_CANCEL)} it or ask the owner what to do`);

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

/** USD the goal's items already cost. */
export const spentOf = (db: Database, goalId: string): number =>
  goalSpent(db, childrenOf(db, goalId));

/** True when the goal's items already cost the goal budget (`goalBudgetOf`): its next item is not started. */
export const goalOverBudget = (db: Database, goalId: string): boolean =>
  goalSpent(db, childrenOf(db, goalId)) >= goalBudgetOf(db, goalId);

/**
 * Route of an item run: `capUsd` = what the goal has left of its budget (`goalBudgetOf`) now, so a run (up to the role budget) can
 * not push the goal past its budget. Runs started in the same pass read the same figure (a known, bounded overshoot).
 */
export const goalRoute = (db: Database, goalId: string): Route => ({
  capUsd: Math.max(0, goalBudgetOf(db, goalId) - goalSpent(db, childrenOf(db, goalId))),
});
