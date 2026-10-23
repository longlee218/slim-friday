/* Caps of the task message exchange: what a run gets pushed in its prompt and what `TaskBoard` pages return.
   Plain constants: no env, no behaviour. The brief cap is `BRIEF_MAX_CHARS` in `orchestrator/teammate/teammate-limits.ts`. */

/** `TaskBoard messages` / `read`: chars of one page. */
export const TASK_BOARD_PAGE_CHARS = 8000;

/** `TaskBoard get`: chars of the preview of one message header. */
export const TASK_BOARD_PREVIEW_CHARS = 200;

/** `TaskBoard get`: most message headers listed (newest are reachable with `messages since`). */
export const TASK_BOARD_HEADERS_MAX = 20;

/** `TaskBoard list`: most items returned. */
export const TASK_BOARD_LIST_MAX_ITEMS = 50;

/** `TaskBoard list`: most goals indexed (newest first). */
export const TASK_BOARD_LIST_MAX_GOALS = 10;

/** `TaskBoard search`: most task matches and most message hits (each). */
export const TASK_BOARD_SEARCH_HITS = 10;

/** Chars of one search hit snippet. */
export const TASK_BOARD_SNIPPET_CHARS = 240;

/** A run's own task thread pushed into its prompt: total chars (the brief is always whole, the rest newest first). */
export const TASK_THREAD_PUSH_CHARS = 12_000;

/** One message of the pushed thread is cut at this many chars (a pointer to `TaskBoard read` follows). */
export const MESSAGE_PUSH_CHARS = 2000;

/** A finished dependency's result pushed into the prompt: excerpt chars (a pointer to the rest follows). */
export const DEPENDENCY_RESULT_PUSH_CHARS = 4000;

/** Largest scratch file (bytes) a `Report result` `files` entry may name: code copies it into `task-files/` at report time; a bigger one is refused. */
export const REPORT_FILE_MAX_BYTES = 5_000_000;

/** A plan item's section text (the part of the plan its heading holds) added to its brief message: chars; the rest is read with `TaskBoard get doc`. */
export const PLAN_SECTION_PUSH_CHARS = 6000;
