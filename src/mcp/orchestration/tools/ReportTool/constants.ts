/** The worker's report tool: milestone progress and the typed end-of-run result (`{ action, params }`). */
export const REPORT_TOOL = "Report";

/** Limits of the worker's report input (defined orchestrator-side, re-exported here). */
export {
  MAX_REQUESTS,
  PROGRESS_NOTE_MAX_CHARS,
  REPORT_SUMMARY_MAX_CHARS,
  REQUEST_MAX_CHARS,
} from "../../../../orchestrator/lead/lead-limits";
