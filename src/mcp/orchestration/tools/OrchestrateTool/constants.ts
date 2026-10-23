/** The teammate's action tool: dispatch, list, steer, retry, cancel, forward, ask the owner, plan, title, register a location (`{ action, params }`). */
export const ORCHESTRATE_TOOL = "Orchestrate";

/** Limits of the `set_title` action. */

/** Title length bounds (chars, after cleaning). */
export const TITLE_MIN_CHARS = 1;
export const TITLE_MAX_CHARS = 60;
/** Digest length bounds (chars, after cleaning): 1-2 short lines folded into one. */
export const DIGEST_MIN_CHARS = 1;
export const DIGEST_MAX_CHARS = 200;
/** Discord's limit for a thread name. */
export const THREAD_NAME_MAX_CHARS = 100;
/** `set_title` calls allowed per run (the counter lives in the tool built for ONE run). The next call is refused. */
export const SET_TITLE_MAX_CALLS_PER_RUN = 2;
