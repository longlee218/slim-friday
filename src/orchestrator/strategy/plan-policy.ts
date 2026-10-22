import { CHAIN_CAP, DISPATCHES_PER_RUN } from "../../config/lead-caps";
import {
  ORCHESTRATE_ACTION_STEER,
  orchestrateRef,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { PLANNER_KEY } from "../plan/plan-types";
import type { Caps, GoalState } from "./caps";

/** Item statuses that ended for good. */
const ENDED = new Set(["completed", "failed", "cancelled"]);

/* Pure policy of `Orchestrate request_plan`: may the lead start a planner now? Same caps as a dispatch (a planner run is one start). */

/** Refusal codes, checked in this order. */
type PlanRequestRefusal =
  | "ONE_PER_RUN"
  | "CHAIN_CAP"
  | "GOAL_OPEN"
  | "BAD_TASK"
  | "PLANNER_RUNNING";

/** The policy answer. */
export type PlanRequestCheck =
  | { ok: true }
  | { ok: false; code: PlanRequestRefusal; message: string };

const refuse = (code: PlanRequestRefusal, message: string): PlanRequestCheck => ({
  ok: false,
  code,
  message,
});

/**
 * Check a plan request. `goalId` names the open goal to plan inside (it keeps its finished items), or the wave goal the
 * thread holds (cap hit / stalled); without it the thread must have no open goal. One planner per goal at a time. First
 * failing rule wins.
 */
export function checkPlanRequest(
  state: GoalState,
  req: { goalId?: string },
  caps: Caps,
): PlanRequestCheck {
  if (caps.dispatchedThisRun >= DISPATCHES_PER_RUN)
    return refuse("ONE_PER_RUN", "One dispatch or plan request per lead run: wait for the result.");
  if (req.goalId && req.goalId !== state.openGoalId && req.goalId !== state.waveHeldGoalId)
    return refuse(
      "BAD_TASK",
      `Goal ${req.goalId} is not this thread's open goal: list and use the open goal's id.`,
    );
  // A second planner would revise the plan under the one the owner may be reading, and burn the wave count.
  if (
    req.goalId &&
    state.items.some((i) => i.itemKey?.startsWith(PLANNER_KEY) && !ENDED.has(i.status))
  )
    return refuse(
      "PLANNER_RUNNING",
      `A planner of this goal is still running: wait for its plan, or ${orchestrateRef(ORCHESTRATE_ACTION_STEER)} the planner with the new words.`,
    );
  if (!req.goalId && state.openGoalId)
    return refuse(
      "GOAL_OPEN",
      `Goal ${state.openGoalId} is open: pass it as goalId to plan inside it, or cancel it first.`,
    );
  if (caps.chainCount + 1 > CHAIN_CAP)
    return refuse(
      "CHAIN_CAP",
      `At most ${CHAIN_CAP} chained starts without an owner message: ask the owner first.`,
    );
  return { ok: true };
}
