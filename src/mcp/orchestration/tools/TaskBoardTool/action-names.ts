import { TASK_BOARD_TOOL } from "./constants";

/* Action names of the `TaskBoard` tool (kept out of `constants.ts`, see the `Report` tool's `action-names.ts`). */

/** Goals of the thread and the items of one goal with their state, question and result pointer. */
export const TASK_BOARD_ACTION_LIST = "list";
/** One task in full: fields, dependencies, result, attempts, events and its first message headers. */
export const TASK_BOARD_ACTION_GET = "get";
/** The messages of one task's thread in order, paged by `since`. */
export const TASK_BOARD_ACTION_MESSAGES = "messages";
/** One message in full, paged by `offset`. */
export const TASK_BOARD_ACTION_READ = "read";
/** Find tasks and messages of this thread by words. */
export const TASK_BOARD_ACTION_SEARCH = "search";

/** Values of `TaskBoard get` `doc`: the spec or the plan text of a goal. */
export const TASK_BOARD_DOC_SPEC = "spec";
export const TASK_BOARD_DOC_PLAN = "plan";

/** How prose and refusal messages name a call: `TaskBoard list`. */
export const taskBoardRef = (action: string): string => `${TASK_BOARD_TOOL} ${action}`;
