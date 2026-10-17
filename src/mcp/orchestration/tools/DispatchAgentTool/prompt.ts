/** Description the model reads for the `DispatchAgent` tool. */
export const DISPATCH_AGENT_DESCRIPTION =
  "Start work with specialist workers. DIRECT = one assignment. DELEGATE = up to 3 chained assignments " +
  "(dependsOn forms a line, no cycle). Each assignment: key, role (from the roster), a self-contained brief, " +
  "optional location. effects (optional) lists the push / PR / merge the workers need (tool, location, branch or into): " +
  "the owner is asked once; without it workers only read, write locally and delete to the trash. Code checks the rules and answers with the goal and item ids, or a coded refusal " +
  "(GOAL_OPEN, NOT_WORKER, BAD_LOCATION, BAD_GRANT, OWNER_DENIED, TOO_MANY, CYCLE, NEEDS_PLAN = call RequestPlan, CHAIN_CAP, ONE_PER_RUN). " +
  "One dispatch per run; workers start after this run ends. Set supersedes to the open goal's id to replace it.";
