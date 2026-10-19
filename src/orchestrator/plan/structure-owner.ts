import { CANCEL_TASK_TOOL } from "../../mcp/orchestration/tools/CancelTaskTool/constants";
import { DISPATCH_AGENT_TOOL } from "../../mcp/orchestration/tools/DispatchAgentTool/constants";
import { REQUEST_PLAN_TOOL } from "../../mcp/orchestration/tools/RequestPlanTool/constants";
import type { StructureOwner } from "../../storage/owned-task-store";

/* The structure boundary of a goal: its items, dependencies and criteria belong to ONE side. The lead owns a DIRECT /
   DELEGATE goal, the planner owns a PLAN goal. Code refuses a write from the other side with a coded refusal that names
   the right tool. (RequestPlan is the lead's hand-over, not a write: it switches lead -> planner.) */

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
      ? `The structure of a PLAN goal belongs to the planner: call ${REQUEST_PLAN_TOOL} with its goalId to re-plan, or ${CANCEL_TASK_TOOL}.`
      : `This goal's structure belongs to the lead (${DISPATCH_AGENT_TOOL} items): a plan starts with ${REQUEST_PLAN_TOOL} on the goal.`;
  return { ok: false, code: NOT_STRUCTURE_OWNER, message };
}

/** GOAL_OPEN text of a dispatch while a goal is open: the way out depends on who owns the goal (a PLAN goal is never "just superseded"). */
export const goalOpenMessage = (goalId: string, owner: StructureOwner): string =>
  owner === "planner"
    ? `Goal ${goalId} is an open PLAN goal: wait for it, call ${REQUEST_PLAN_TOOL} with its goalId to re-plan, or ${CANCEL_TASK_TOOL} it.`
    : `Goal ${goalId} is open: set supersedes to its id or wait.`;
