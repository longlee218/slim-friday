import { ORCHESTRATE_TOOL } from "./constants";

/* Action names of the lead's `Orchestrate` tool (kept out of `constants.ts`, see the `Plan` tool's `action-names.ts`). */

/** Start a goal with one worker (DIRECT) or a few chained workers (DELEGATE). */
export const ORCHESTRATE_ACTION_DISPATCH = "dispatch";
/** Add one task to the open goal (DIRECT / DELEGATE goals only: a PLAN goal belongs to the planner). */
export const ORCHESTRATE_ACTION_ADD = "add";
/** Change a task that has not started (subject, brief, priority, dependsOn, role). */
export const ORCHESTRATE_ACTION_UPDATE = "update";
/** One task or goal in full: fields, dependencies, full result text, attempts, last events. */
export const ORCHESTRATE_ACTION_GET = "get";
/** Find this thread's goals and tasks by the words of their subject and brief. */
export const ORCHESTRATE_ACTION_SEARCH = "search";
/** Read the goal / item facts from the database (never from session memory). */
export const ORCHESTRATE_ACTION_LIST = "list";
/** Send owner text to a running worker (or answer its pending question). */
export const ORCHESTRATE_ACTION_STEER = "steer";
/** Re-queue a held (failed) task: it resumes its session with the lead's note. */
export const ORCHESTRATE_ACTION_RETRY = "retry";
/** Cancel a task (its dependents too) and abort its run. */
export const ORCHESTRATE_ACTION_CANCEL = "cancel";
/** Post a finished item's result to the owner (verbatim file or excerpt). */
export const ORCHESTRATE_ACTION_FORWARD = "forward";
/** Ask the owner a question (yes/no, select or text); the answer comes back as the result. */
export const ORCHESTRATE_ACTION_ASK_OWNER = "ask_owner";
/** Open (or reuse) a goal and start the planner on it; the lead never plans itself. */
export const ORCHESTRATE_ACTION_REQUEST_PLAN = "request_plan";
/** Ask the owner to approve a valid plan once; yes starts its items. */
export const ORCHESTRATE_ACTION_APPROVE_PLAN = "approve_plan";
/** Name a thread and store its digest (a run with a rename port). */
export const ORCHESTRATE_ACTION_SET_TITLE = "set_title";
/** Register a directory the owner named as a location of the thread's space. */
export const ORCHESTRATE_ACTION_REGISTER_LOCATION = "register_location";

/** How prose and refusal messages name a call: `Orchestrate retry`. */
export const orchestrateRef = (action: string): string => `${ORCHESTRATE_TOOL} ${action}`;

/** Audit name of a lead call (`effect_log.tool`, `metrics:lead`): tool and action in one column, `Orchestrate.retry`. */
export const orchestrateAudit = (action: string): string => `${ORCHESTRATE_TOOL}.${action}`;
