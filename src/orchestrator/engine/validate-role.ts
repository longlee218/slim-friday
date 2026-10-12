import type { RoleDefinition } from "../../roles/role-types";
import { stageKind } from "./gates";

/* Pre-run check of a role's data: every stage must be one this engine can run, BEFORE the first stage starts
   (a refusal then has no side effect: no row, no model call). */

/**
 * Refusal text when the engine cannot run `role` as data says, else undefined. `hasClone`: the run is a
 * follow-up in the thread's existing (legacy) clone.
 */
export function validateRole(role: RoleDefinition, hasClone: boolean): string | undefined {
  for (const [idx, stage] of role.stages.entries()) {
    const kind = stageKind(stage);
    if (kind === "unsupported") return `Stage ${stage.name} has a gate this engine cannot run.`;
    // A plain stage answers through the `answer` output; no other output has a handler there.
    if (kind === "plain" && role.output !== "answer")
      return `Stage ${stage.name} has no handler for output "${role.output}".`;
    if (kind === "plan" && stageKind(role.stages[idx + 1] ?? stage) !== "repo")
      return "The stage after the plan gate must run in the repo.";
  }
  // Without `followUp` a message in an existing clone would restart at stage 0 and plan again.
  if (hasClone && !role.followUp && role.stages.some((s) => stageKind(s) === "repo"))
    return `Role ${role.name} has no follow-up in an existing clone.`;
  return undefined;
}
