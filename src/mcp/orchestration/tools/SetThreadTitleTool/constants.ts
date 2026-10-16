/** Name a thread and store its digest (a run with a rename port; rollover/lean runs never see it). */
export const SET_THREAD_TITLE_TOOL = "SetThreadTitle";

/** Limits of the `SetThreadTitle` tool. */

/** Title length bounds (chars, after cleaning). */
export const TITLE_MIN_CHARS = 1;
export const TITLE_MAX_CHARS = 60;
/** Digest length bounds (chars, after cleaning): 1-2 short lines folded into one. */
export const DIGEST_MIN_CHARS = 1;
export const DIGEST_MAX_CHARS = 200;
/** Discord's limit for a thread name. */
export const THREAD_NAME_MAX_CHARS = 100;
/** Calls allowed per run (the counter lives in the server built for ONE run). The next call is refused. */
export const SET_THREAD_TITLE_MAX_CALLS_PER_RUN = 2;
