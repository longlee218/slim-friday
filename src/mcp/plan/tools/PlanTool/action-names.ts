/* Action names of the `Plan` tool. Kept out of `constants.ts`: the tool-name scan treats every string in a tool's
   `constants.ts` as a tool name, and words like "list" or "create" are not. */

/** The goal's request, locations, channel digest, finished and deferred items, the plan so far. */
export const PLAN_ACTION_CONTEXT = "context";
/** The worker roles a plan may use. */
export const PLAN_ACTION_CAPABILITIES = "capabilities";
/** Store a plan (version 1, or the next one after a rejected or expired plan). */
export const PLAN_ACTION_CREATE = "create";
/** Run the validator on a stored version again (read-only). */
export const PLAN_ACTION_VALIDATE = "validate";
/** A new plan version from add / cancel / modify. */
export const PLAN_ACTION_REVISE = "revise";
/** One task or goal of this thread in full (fields, dependencies, full result text, attempts, last events). */
export const PLAN_ACTION_GET = "get";
/** Find this thread's goals and tasks by the words of their subject and brief. */
export const PLAN_ACTION_SEARCH = "search";
/** The item table of the goal, with the cause of every blocked, failed or waiting item. */
export const PLAN_ACTION_LIST = "list";
