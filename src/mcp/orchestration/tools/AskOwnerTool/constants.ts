/** Ask the owner a question with buttons; the answer comes back as the tool result. */
export const ASK_OWNER_TOOL = "AskOwner";

/** Limits of the `AskOwner` tool. */

/** The owner has this long (ms) to click before the tool returns a timeout. */
export const ASK_OWNER_TIMEOUT_MS = 10 * 60_000;
/** Option buttons: at least two choices, at most four. */
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 4;
/** Max chars of the question / of one option label. */
export const QUESTION_MAX_CHARS = 600;
export const OPTION_MAX_CHARS = 80;
