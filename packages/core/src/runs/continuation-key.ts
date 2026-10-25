/** Dedupe-key prefix that marks a continuation run. */
export const CONTINUATION_KEY = "cont:";

/** The text of a continuation run (it answers owner messages that came while the bot was busy). */
export const CONTINUATION_PROMPT =
  "Respond to the owner's messages that arrived while you were busy.";
