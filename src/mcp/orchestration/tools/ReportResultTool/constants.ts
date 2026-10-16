/** The worker's typed end-of-run report. */
export const REPORT_RESULT_TOOL = "ReportResult";

/** Limits of the worker's `ReportResult` input (defined orchestrator-side, re-exported here). */
export {
  MAX_REQUESTS,
  REQUEST_MAX_CHARS,
  SUMMARY_MAX_CHARS,
} from "../../../../orchestrator/engine/lead-limits";
