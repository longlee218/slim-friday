import type { RoleDefinition } from "../roles/role-types";
import type { AgentConfig } from "./agent-config";

/* Per-role budgets: HOW MUCH a role run may spend. The model is fixed data (`RoleDefinition.model`). Pure functions. */

/** Per-run routing facts the orchestrator knows; every field is optional (missing = role defaults). */
export interface Route {
  /**
   * Trusted internal note for a NEW query (never shown to the owner, never part of the user prompt or a steer): the
   * fallback re-run's "previous attempt failed" note and the run supervisor's recovery hint. It goes into the system context.
   */
  internalHint?: string;
  /** Extra budget (USD) added to the role budget. */
  extraBudgetUsd?: number;
  /** USD the task's earlier runs (itself and the runs it resumes) already cost; the task ceiling `TASK_BUDGET_USD` is shared with them. */
  spentUsd?: number;
}

/** Per-task spend ceiling (USD) over the task's runs (re-runs included): a run gets at most what is left of it (owner, Rev 14 addendum 2). */
export const TASK_BUDGET_USD = 6.0;

/** True when a run's budget cap IS what the task's earlier runs left of the ceiling (so a raise cannot help). */
export const ceilingBinds = (limitUsd: number | undefined, spentUsd = 0): boolean =>
  limitUsd !== undefined && spentUsd > 0 && Math.abs(limitUsd + spentUsd - TASK_BUDGET_USD) < 1e-6;

/**
 * Budget (USD) of a role run, or undefined = no cap. The role's constant budget
 * plus any owner raise, limited to what is left of
 * TASK_BUDGET_USD, then capped by MAX_BUDGET_USD.
 */
export function resolveBudget(
  role: RoleDefinition,
  route: Route,
  config: AgentConfig,
): number | undefined {
  const cap = config.limits.maxBudgetUsd;
  const base = role.budgetUsd;
  // Task ceiling: the run gets at most what the task's earlier runs left of TASK_BUDGET_USD. An extra budget
  // widens the role budget only, never the ceiling (a hard per-task cost cap by design).
  const left = Math.max(0, TASK_BUDGET_USD - (route.spentUsd ?? 0));
  const total = Math.min(base + (route.extraBudgetUsd ?? 0), left);
  return cap === undefined ? total : Math.min(total, cap);
}
