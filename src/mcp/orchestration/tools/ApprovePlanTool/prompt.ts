/** Description the model reads for the `ApprovePlan` tool. */
export const APPROVE_PLAN_DESCRIPTION =
  "Ask the owner once to approve a valid plan (planId + version from the plan-ready event). Code shows the owner the steps, " +
  "roles, locations, risk, budget and delivery effects. Yes: the plan's steps start after this run, in order, without more questions " +
  "inside the approved limits. No: the plan is rejected. Refused with NO_PLAN, PLAN_NOT_VALID, GOAL_NOT_OPEN, GOAL_CLOSED or BUDGET (before the question: nothing was asked; after the owner's click the same codes can return and the owner was told it did not start), or TIMEOUT or UNCLEAR (the plan stays valid; UNCLEAR carries the text the owner typed: it is a change request). status rejected or a PLAN_EXPIRED timeout event: ask the owner what to change, then RequestPlan with the goalId plans again inside the goal (finished work stays); the new plan needs its own ApprovePlan.";
