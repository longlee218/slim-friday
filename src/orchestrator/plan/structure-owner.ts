import {
  ORCHESTRATE_ACTION_CANCEL,
  ORCHESTRATE_ACTION_REVISE_PLAN,
  orchestrateRef,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import type { StructureOwner } from "../../storage/owned-task-store";

/* The structure boundary of a goal: its items, dependencies and criteria change through ONE path. A DIRECT / DELEGATE
   goal (`lead`) changes through add / update; a PLAN goal (`plan`) changes through create_plan / revise_plan, which
   the owner approves. Code refuses a write through the other path with a coded refusal that names the right tool. */

/** Code of a structure write from the side that does not own the goal. */
export const NOT_STRUCTURE_OWNER = "NOT_STRUCTURE_OWNER";

/** A coded refusal (same shape as the policy and lifecycle refusals). */
export interface StructureRefusal {
  ok: false;
  code: typeof NOT_STRUCTURE_OWNER;
  message: string;
}

/** Refusal when the lead edits the items of a PLAN goal with add / update; undefined when it may. */
export function assertStructureOwner(owner: StructureOwner): StructureRefusal | undefined {
  if (owner === "lead") return undefined;
  return {
    ok: false,
    code: NOT_STRUCTURE_OWNER,
    message: `The items of a PLAN goal change through ${orchestrateRef(ORCHESTRATE_ACTION_REVISE_PLAN)} (the owner approves the new version), or ${orchestrateRef(ORCHESTRATE_ACTION_CANCEL)}.`,
  };
}

/** GOAL_OPEN text of a dispatch while a goal is open: the way out depends on who owns the goal (a PLAN goal is never "just superseded"). */
export const goalOpenMessage = (goalId: string, owner: StructureOwner): string =>
  owner === "plan"
    ? `Goal ${goalId} is an open PLAN goal: wait for it, call ${orchestrateRef(ORCHESTRATE_ACTION_REVISE_PLAN)} or create_plan with its goalId to re-plan, or ${orchestrateRef(ORCHESTRATE_ACTION_CANCEL)} it.`
    : `Goal ${goalId} is open: set supersedes to its id or wait.`;
