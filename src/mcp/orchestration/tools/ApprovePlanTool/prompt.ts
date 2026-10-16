/** Description the model reads for the `ApprovePlan` tool. */
export const APPROVE_PLAN_DESCRIPTION =
  "Ask the owner once to approve a valid plan (planId + version from the plan-ready event). Code shows the owner the steps, " +
  "roles, locations, risk, budget and delivery effects. Yes: the plan's steps start after this run, in order, without more questions " +
  "inside the approved limits. No: the plan is rejected. Refused with NO_PLAN, PLAN_NOT_VALID, TIMEOUT or UNCLEAR (the plan stays valid).";
