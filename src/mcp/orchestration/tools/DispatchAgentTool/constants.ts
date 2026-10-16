/** Start a goal with one worker (DIRECT) or up to three chained workers (DELEGATE). */
export const DISPATCH_AGENT_TOOL = "DispatchAgent";

/** Limits of the `DispatchAgent` tool input. */

/** Max chars of one worker brief. */
export const BRIEF_MAX_CHARS = 4000;
/** Max chars of the intent / reason sentences. */
export const REASON_MAX_CHARS = 400;
/** Most assignments a request may carry (more than the policy allows, so the policy can answer NEEDS_PLAN). */
export const MAX_ASSIGNMENTS = 8;
