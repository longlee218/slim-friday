/** Description the model reads for the worker's `ReportResult` tool. */
export const REPORT_RESULT_DESCRIPTION =
  "Report how your job ended, once, as your last action. title: a short descriptive title of the result (it becomes " +
  "the result file's heading and name). status: COMPLETED, FAILED, BLOCKED, NEEDS_PLANNING (the " +
  "job is too big or unclear to do safely) or NEEDS_CLARIFICATION (the owner must answer something). summary: the " +
  "result or the reason, with evidence (paths, commands run). requests: follow-ups you need (question, capability, plan), one per entry; a question for the owner goes in requests, never in summary. artifacts: ids of what you saved, or {title, path} of a doc you wrote in your location (path relative to it); a refused entry is named in the result, fix it and report again.";
