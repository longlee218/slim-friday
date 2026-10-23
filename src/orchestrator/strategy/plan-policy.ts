import { CHAIN_CAP, DISPATCHES_PER_RUN } from "../../config/teammate-caps";
import type { Caps, GoalState } from "./caps";

/* Pure policy of `Orchestrate create_plan`: may the teammate store a plan now? Same caps as a dispatch (a plan is one start). */

/** Refusal codes, checked in this order. */
type PlanRequestRefusal = "ONE_PER_RUN" | "CHAIN_CAP" | "GOAL_OPEN" | "BAD_TASK";

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
 * Check a plan request. `goalId` names the open goal to plan inside (it keeps its finished items); without it the thread
 * must have no open goal. First failing rule wins.
 */
export function checkPlanRequest(
  state: GoalState,
  req: { goalId?: string },
  caps: Caps,
): PlanRequestCheck {
  if (caps.dispatchedThisRun >= DISPATCHES_PER_RUN)
    return refuse(
      "ONE_PER_RUN",
      "One dispatch or plan request per teammate run: wait for the result.",
    );
  if (req.goalId && req.goalId !== state.openGoalId)
    return refuse(
      "BAD_TASK",
      `Goal ${req.goalId} is not this thread's open goal: list and use the open goal's id.`,
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
