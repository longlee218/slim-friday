/* Prompts of the rollover runs (memory flush, thread summary): text only, the runs live in `src/session/`. */

/** Prompt of the flush run (a resumed run of the thread's session: it already holds the whole conversation). */
export const FLUSH_PROMPT =
  "Before this conversation is reset: capture durable memories with the MemorySave tool " +
  "(scope journal for decisions, facts, preferences and open items of this thread; scope location or workspace only when " +
  "clearly durable). If there is nothing to store, reply NO_REPLY.";

/** Merge rule shared by the `/compact` instructions and the Haiku fallback prompt. */
export const MERGE_RULES =
  "Merge it with this conversation. Keep decisions, open tasks, names and paths; drop chit-chat.";

/** `/compact` instructions: the previous summary rides in the instruction text (the SDK sees only the transcript). */
export const compactPrompt = (previous: string): string =>
  previous
    ? `/compact Existing context: ${previous}\n\n${MERGE_RULES}`
    : `/compact Summarize this conversation. Keep decisions, open tasks, names and paths; drop chit-chat.`;
