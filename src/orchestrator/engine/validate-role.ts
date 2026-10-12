import type { RoleDefinition } from "../../roles/role-types";
import { stageKind } from "./gates";

/* Pre-run check of a role's data: every stage must be one this engine can run, BEFORE the first stage starts
   (a refusal then has no side effect: no row, no model call). */

/**
 * Refusal text when the engine cannot run `role` as data says, else undefined.
 */
export function validateRole(role: RoleDefinition): string | undefined {
  for (const [idx, stage] of role.stages.entries()) {
    const kind = stageKind(stage);
    if (kind === "unsupported") return `Stage ${stage.name} has a gate this engine cannot run.`;
    // A plain stage answers through the `answer` output; no other output has a handler there.
    if (kind === "plain" && role.output !== "answer")
      return `Stage ${stage.name} has no handler for output "${role.output}".`;
    if (kind === "plan" && stageKind(role.stages[idx + 1] ?? stage) !== "repo")
      return "The stage after the plan gate must run in the repo.";
  }
  return undefined;
}
