import type { RoleDefinition } from "../../roles/role-types";

/* Pre-run check of a role's data, BEFORE the run starts (a refusal has no side effect: no row, no model call).
   Roles come from config files later: bad data must refuse, not crash mid-run. */

/** Refusal text when the engine cannot run `role` as data says, else undefined. */
export function validateRole(role: RoleDefinition): string | undefined {
  if (!(role.budgetUsd > 0)) return `Role ${role.name} has no positive budget.`;
  return undefined;
}
