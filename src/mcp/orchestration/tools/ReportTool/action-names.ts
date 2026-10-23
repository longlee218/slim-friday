/* Action names of the `Report` tool (kept out of `constants.ts`, see the `Plan` tool's `action-names.ts`). */

/** Milestone report: percent + note. Tells the teammate the worker is alive; does not end the job. */
export const REPORT_ACTION_PROGRESS = "progress";
/** The run cannot go on: say what blocks it and what it needs. Ends the run, holds the task, wakes the teammate now. */
export const REPORT_ACTION_BLOCKER = "blocker";
/** The typed end-of-run report, once, as the last action. */
export const REPORT_ACTION_RESULT = "result";
