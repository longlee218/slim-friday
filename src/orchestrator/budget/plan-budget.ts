import { PLAN_BUDGET_RESERVE_FACTOR, PLAN_GOAL_BUDGET_MAX_USD } from "../../config/model-routing";
import { findRole } from "../../roles/role-registry";
import type { RoleDefinition } from "../../roles/role-types";
import { VERIFY_ROLE } from "../plan/plan-types";
import { isWriterRole } from "../plan/verify-items";

/* Plan budget computed by code: the teammate never sets it (an LLM cannot price runs). */

/** What the budget reads of a plan item: its role and location. */
interface BudgetItem {
  role: string;
  location?: string | undefined;
}

/**
 * The goal budget (USD) of one plan version:
 * 1. sum of the role `budgetUsd` ceiling of every item in the version (a cancelled item has left the version and does not count);
 * 2. plus one verify run (the `tester` ceiling) per location that has a writer item, when the plan has acceptance
 *    criteria (code appends those `verify-N` runs, see verify-ensure.ts);
 * 3. times `PLAN_BUDGET_RESERVE_FACTOR` (fix loops, resumes, slack), rounded up to a whole dollar;
 * 4. when that is not above what the goal already spent (earlier items or a rejected plan), the spend is added
 *    on top: `ceil(spent + reserve sum)`, so a re-plan still has room for its own items;
 * 5. capped at `PLAN_GOAL_BUDGET_MAX_USD` (no refusal: dispatch stops when the spend reaches it, the budget_hit path).
 * An unknown role counts 0 (the validator refuses it anyway). Pure apart from the static role registry (`roleOf`).
 */
export function planBudgetUsd(a: {
  items: readonly BudgetItem[];
  /** True when the plan has acceptance criteria (verify runs are appended). */
  verifies: boolean;
  /** USD the goal already spent. */
  spentUsd: number;
  roleOf?: (name: string) => RoleDefinition | undefined;
}): number {
  const roleOf = a.roleOf ?? findRole;
  const ceiling = (name: string): number => roleOf(name)?.budgetUsd ?? 0;
  const runs = a.items.reduce((sum, i) => sum + ceiling(i.role), 0);
  const writerLocations = new Set(
    a.items.flatMap((i) => (i.location && isWriterRole(roleOf(i.role)) ? [i.location] : [])),
  );
  const verifyRuns = a.verifies ? writerLocations.size * ceiling(VERIFY_ROLE) : 0;
  const reserved = (runs + verifyRuns) * PLAN_BUDGET_RESERVE_FACTOR;
  const own = Math.ceil(reserved);
  const budget = own > a.spentUsd ? own : Math.ceil(a.spentUsd + reserved);
  return Math.min(budget, PLAN_GOAL_BUDGET_MAX_USD);
}
