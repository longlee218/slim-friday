import { PLAN_MAX_ITEMS } from "../../config/lead-caps";

/* Input limits and timeouts of the lead's and the worker's typed tools. They are orchestrator rules (the zod shapes in
   lead-schemas.ts and the ask relay enforce them), so they live here; each tool's `constants.ts` re-exports its own.
   Leaf file: imports only `config/lead-caps` (a leaf too), so the dependency runs orchestrator -> tool constants never the other way. */

/** The owner has this long (ms) to click before `Orchestrate ask_owner` returns a timeout. */
export const ASK_OWNER_TIMEOUT_MS = 10 * 60_000;
/** `Orchestrate ask_owner` `select` options: at least two choices, at most 25 (the Discord select-menu cap; buttons up to 5). */
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 25;
/** Max chars of the `Orchestrate ask_owner` question / of one option label. */
export const QUESTION_MAX_CHARS = 600;
export const OPTION_MAX_CHARS = 80;

/** `Orchestrate register_location`: longest path accepted, and calls allowed per lead run. */
export const PATH_MAX_CHARS = 1024;
export const REGISTER_LOCATION_MAX_PER_RUN = 1;
/** Longest project folder name (slug) of a new project made under the default projects dir. */
export const PROJECT_NAME_MAX_CHARS = 40;

/** Max chars of the text a `Orchestrate steer` call sends to a worker. */
export const STEER_TEXT_MAX_CHARS = 4000;

/** Max chars of one `Orchestrate dispatch` worker brief. */
export const BRIEF_MAX_CHARS = 4000;
/** Max chars of the `Orchestrate dispatch` intent / reason sentences. */
export const REASON_MAX_CHARS = 400;
/** Most assignments a `Orchestrate dispatch` request may carry (more than the policy allows, so the policy can answer NEEDS_PLAN). */
export const MAX_ASSIGNMENTS = PLAN_MAX_ITEMS;

/** Max chars of the worker's `Report` result summary. */
export const REPORT_SUMMARY_MAX_CHARS = 4000;
/** Most follow-up requests one report may carry; max chars of one request. */
export const MAX_REQUESTS = 5;
export const REQUEST_MAX_CHARS = 500;

/** Max chars of the worker's `Report` progress note. */
export const PROGRESS_NOTE_MAX_CHARS = 200;

/** Max chars of a `search` query, and most matches it returns. */
export const SEARCH_QUERY_MAX_CHARS = 200;
export const SEARCH_MAX_RESULTS = 10;

/** `get`: most chars of an item's full result text (the primary result file, redacted), and most recent events listed. */
export const GET_RESULT_MAX_CHARS = 8000;
export const GET_EVENTS_MAX = 5;

/** Max chars of the worker's `Report blocker` reason. */
export const BLOCKER_REASON_MAX_CHARS = 1000;
