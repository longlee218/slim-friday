import type { Database } from "bun:sqlite";
import { PLAN_ACTION_CREATE } from "../../mcp/plan/tools/PlanTool/action-names";
import { PLAN_TOOL } from "../../mcp/plan/tools/PlanTool/constants";
import { childrenOf } from "../../storage/owned-item-store";
import {
  latestPlan,
  newestApprovedVersion,
  planVersions,
  type WorkPlanRow,
} from "../../storage/work-plan-store";
import { spentOf } from "../budget/task-budget";
import type { PlanCtx, PlanError } from "./plan-types";

/* Refusals and goal-key facts shared by the plan lifecycle, revision and the planner tools. */

/** Registry and goal facts the validator reads; `existingKeys` and `revisions` are computed here. */
export type PlanEnv = Pick<PlanCtx, "workerRoles" | "locations" | "goalBudgetUsd">;

/** A coded refusal; `errors` holds the validator's list for CODE INVALID. */
export interface Fail {
  ok: false;
  code: string;
  message: string;
  errors?: PlanError[];
}
export const fail = (code: string, message: string): Fail => ({ ok: false, code, message });

/** The validator's errors as one refusal. */
export const invalid = (errors: PlanError[]): Fail => ({
  ok: false,
  code: "INVALID",
  message: errors.map((e) => `${e.code}${e.key ? `(${e.key})` : ""}: ${e.message}`).join(" | "),
  errors,
});

/** Keys of the goal's items that a plan with `planKeys` does not own (planner runs, earlier finished work). */
export const otherKeys = (db: Database, goalId: string, planKeys: readonly string[]): string[] =>
  childrenOf(db, goalId).flatMap((i) =>
    i.itemKey && !planKeys.includes(i.itemKey) ? [i.itemKey] : [],
  );

/** Keys of the goal's items that ended `failed` / `cancelled` (a new item must not wait for them). */
export const deadKeys = (db: Database, goalId: string): string[] =>
  childrenOf(db, goalId).flatMap((i) =>
    i.itemKey && (i.status === "failed" || i.status === "cancelled") ? [i.itemKey] : [],
  );

/**
 * Keys of the goal's held NEEDS_PLANNING items that the FIRST approval will release (cancel): a plan item must not wait for
 * them. Empty once the goal has an approved version (nothing is released again).
 */
export const releasedKeys = (db: Database, goalId: string): string[] =>
  newestApprovedVersion(db, goalId)
    ? []
    : childrenOf(db, goalId).flatMap((i) =>
        i.itemKey && i.status === "blocked" && i.resultKind === "NEEDS_PLANNING" ? [i.itemKey] : [],
      );

/**
 * The version a revision builds on: the newest one still alive (valid or approved), so after the owner rejected or let a
 * version expire it is the older approved one. The planner reads the newest version, so its number is accepted too.
 */
export function reviseBase(
  db: Database,
  planId: string,
  baseVersion: number,
): { ok: true; base: WorkPlanRow } | Fail {
  const latest = latestPlan(db, planId);
  if (!latest) return fail("NO_PLAN", `Plan ${planId} not found.`);
  const base = planVersions(db, planId)
    .filter((v) => v.status === "valid" || v.status === "approved")
    .pop();
  if (!base)
    return fail(
      "BAD_STATE",
      `Plan v${latest.version} is ${latest.status} and no version is approved: use ${PLAN_TOOL} ${PLAN_ACTION_CREATE} to plan again.`,
    );
  if (baseVersion !== base.version && baseVersion !== latest.version)
    return fail(
      "STALE_VERSION",
      `The latest version is ${latest.version}, not ${baseVersion}: read it again.`,
    );
  return { ok: true, base };
}

/** What the validator reads about the goal: keys the plan does not own, dead keys, revisions so far, spend. */
export const validatorCtx = (
  db: Database,
  goalId: string,
  env: PlanEnv,
  planKeys: readonly string[],
  revisions: number,
): PlanCtx => ({
  ...env,
  existingKeys: otherKeys(db, goalId, planKeys),
  deadKeys: deadKeys(db, goalId),
  releasedKeys: releasedKeys(db, goalId),
  revisions,
  spentUsd: spentOf(db, goalId),
});
