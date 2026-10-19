import {
  ORCHESTRATE_ACTION_CANCEL,
  ORCHESTRATE_ACTION_DISPATCH,
  ORCHESTRATE_ACTION_REQUEST_PLAN,
  orchestrateRef,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import type { StructureOwner } from "../../storage/owned-task-store";

/* The structure boundary of a goal: its items, dependencies and criteria belong to ONE side. The lead owns a DIRECT /
   DELEGATE goal, the planner owns a PLAN goal. Code refuses a write from the other side with a coded refusal that names
   the right tool. (Orchestrate request_plan is the lead's hand-over, not a write: it switches lead -> planner.) */

/** Code of a structure write from the side that does not own the goal. */
export const NOT_STRUCTURE_OWNER = "NOT_STRUCTURE_OWNER";

/** A coded refusal (same shape as the policy and lifecycle refusals). */
export interface StructureRefusal {
  ok: false;
  code: typeof NOT_STRUCTURE_OWNER;
  message: string;
}

/** Refusal when `actor` changes the structure of a goal owned by `owner`; undefined when it may. */
export function assertStructureOwner(
  owner: StructureOwner,
  actor: StructureOwner,
): StructureRefusal | undefined {
  if (owner === actor) return undefined;
  const message =
    actor === "lead"
      ? `The structure of a PLAN goal belongs to the planner: call ${orchestrateRef(ORCHESTRATE_ACTION_REQUEST_PLAN)} with its goalId to re-plan, or ${orchestrateRef(ORCHESTRATE_ACTION_CANCEL)}.`
      : `This goal's structure belongs to the lead (${orchestrateRef(ORCHESTRATE_ACTION_DISPATCH)} items): a plan starts with ${orchestrateRef(ORCHESTRATE_ACTION_REQUEST_PLAN)} on the goal.`;
  return { ok: false, code: NOT_STRUCTURE_OWNER, message };
}

/** GOAL_OPEN text of a dispatch while a goal is open: the way out depends on who owns the goal (a PLAN goal is never "just superseded"). */
export const goalOpenMessage = (goalId: string, owner: StructureOwner): string =>
  owner === "planner"
    ? `Goal ${goalId} is an open PLAN goal: wait for it, call ${orchestrateRef(ORCHESTRATE_ACTION_REQUEST_PLAN)} with its goalId to re-plan, or ${orchestrateRef(ORCHESTRATE_ACTION_CANCEL)} it.`
    : `Goal ${goalId} is open: set supersedes to its id or wait.`;
