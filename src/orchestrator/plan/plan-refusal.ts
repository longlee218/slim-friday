import type { Database } from "bun:sqlite";
import { childrenOf } from "../../storage/owned-item-store";
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
