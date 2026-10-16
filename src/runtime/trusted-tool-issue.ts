/** Issue codes a Friday-owned tool reports (a closed set: free-form text or a raw exception is never a code). */
export const TRUSTED_TOOL_ISSUE_CODES = [
  "invalid_input",
  "not_found",
  "temporarily_busy",
  "limit",
  "unavailable",
] as const;
export type TrustedToolIssueCode = (typeof TRUSTED_TOOL_ISSUE_CODES)[number];

/** The one feasible next step the model is given for each code. */
const NEXT_STEP: Record<TrustedToolIssueCode, string> = {
  invalid_input: "Fix the input and call the tool again.",
  not_found: "Check the id or name, or search again with other words.",
  temporarily_busy: "Wait a moment, then try once more.",
  limit: "Do not call this tool again in this run; continue without it.",
  unavailable: "Continue without this tool; do not retry it.",
};

/**
 * Model-facing text of a known tool outcome: the code, an optional `detail` (a Friday-written constant, never raw
 * exception or stderr text) and one next step.
 */
export const formatTrustedToolIssue = (code: TrustedToolIssueCode, detail?: string): string =>
  `${code}${detail ? `: ${detail}` : ""}. ${NEXT_STEP[code]}`;
