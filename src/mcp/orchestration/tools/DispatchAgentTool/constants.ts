/** Start a goal with one worker (DIRECT) or up to three chained workers (DELEGATE). */
export const DISPATCH_AGENT_TOOL = "DispatchAgent";

/** Limits of the `DispatchAgent` tool input (defined orchestrator-side, re-exported here). */
export {
  BRIEF_MAX_CHARS,
  MAX_ASSIGNMENTS,
  REASON_MAX_CHARS,
} from "../../../../orchestrator/lead/lead-limits";
