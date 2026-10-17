/* Input limits and timeouts of the lead's and the worker's typed tools. They are orchestrator rules (the zod shapes in
   lead-schemas.ts and the ask relay enforce them), so they live here; each tool's `constants.ts` re-exports its own.
   Leaf file: no imports, so the dependency runs orchestrator -> tool constants never the other way. */

/** The owner has this long (ms) to click before `AskOwner` returns a timeout. */
export const ASK_OWNER_TIMEOUT_MS = 10 * 60_000;
/** `AskOwner` option buttons: at least two choices, at most four. */
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 4;
/** Max chars of the `AskOwner` question / of one option label. */
export const QUESTION_MAX_CHARS = 600;
export const OPTION_MAX_CHARS = 80;

/** Max chars of the text a `SteerTask` call sends to a worker. */
export const STEER_TEXT_MAX_CHARS = 4000;

/** Max chars of one `DispatchAgent` worker brief. */
export const BRIEF_MAX_CHARS = 4000;
/** Max chars of the `DispatchAgent` intent / reason sentences. */
export const REASON_MAX_CHARS = 400;
/** Most assignments a `DispatchAgent` request may carry (more than the policy allows, so the policy can answer NEEDS_PLAN). */
export const MAX_ASSIGNMENTS = 8;

/** Max chars of the worker's `ReportResult` summary. */
export const SUMMARY_MAX_CHARS = 4000;
/** Most follow-up requests one report may carry; max chars of one request. */
export const MAX_REQUESTS = 5;
export const REQUEST_MAX_CHARS = 500;

/** Max chars of the worker's `ReportProgress` note. */
export const PROGRESS_NOTE_MAX_CHARS = 200;
