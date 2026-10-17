/** Description the model reads for the `RequestPlan` tool. */
export const REQUEST_PLAN_DESCRIPTION =
  "Start the planner for a big, branching or risky request (you never plan yourself). Give the objective in the owner's terms " +
  "and what is known (findings). Set goalId to the open goal to plan inside it (its finished items are kept). The planner " +
  "runs after this run ends; when its plan is ready you are told (event with the plan id and version), then call ApprovePlan. " +
  "Refused with ONE_PER_RUN, CHAIN_CAP, GOAL_OPEN or BAD_TASK.";
