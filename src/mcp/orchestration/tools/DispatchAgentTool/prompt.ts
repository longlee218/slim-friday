import { DELEGATE_MAX } from "../../../../config/lead-caps";

/** Description the model reads for the `DispatchAgent` tool. */
export const DISPATCH_AGENT_DESCRIPTION =
  `Start work with specialist workers. DIRECT = one assignment. DELEGATE = up to ${DELEGATE_MAX} chained assignments ` +
  "(dependsOn forms a line, no cycle). Each assignment: key, role (from the roster), a self-contained brief, " +
  "optional location. effects (optional) lists the push / PR / merge the workers need (tool, location, branch or into): " +
  "the owner is asked once; without it workers only read, write locally and delete to the trash. Code checks the rules and answers with the goal and item ids, or a coded refusal " +
  "(GOAL_OPEN, NOT_WORKER, BAD_LOCATION, BAD_GRANT, OWNER_DENIED, TOO_MANY, CYCLE, NEEDS_PLAN = call RequestPlan, CHAIN_CAP, ONE_PER_RUN). " +
  "One dispatch per run; workers start after this run ends. supersedes (the open goal's id) replaces a DIRECT/DELEGATE goal; a PLAN goal is re-planned with RequestPlan(goalId) or cancelled, and replacing it asks the owner.";
