/** Description the model reads for the `RequestPlan` tool. */
export const REQUEST_PLAN_DESCRIPTION =
  "Start the planner for a big, branching or risky request (you never plan yourself). Give the objective in the owner's terms " +
  "and what is known (findings). Set goalId to the open goal, or to a wave goal held at WAVE_CAP / WAVE_STALLED, to plan inside it (its finished and deferred items are kept), also after the owner rejected a plan or it expired. Past the wave cap the plan is a re-plan the owner approves like any plan. The planner " +
  "runs after this run ends; when its plan is ready you are told (event with the plan id and version), then call ApprovePlan. " +
  "Refused with ONE_PER_RUN, CHAIN_CAP, GOAL_OPEN, BAD_TASK or PLANNER_RUNNING (wait for that planner).";
