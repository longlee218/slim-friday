/** Kinds of a task message: what the text is. */
export const MESSAGE_KINDS = [
  "brief",
  "steer",
  "question",
  "answer",
  "note",
  "progress",
  "blocker",
  "result",
] as const;

/** One message kind. */
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Author of a message written by code (state changes the next run should know about). */
export const AUTHOR_SYSTEM = "system";
/** Author of the lead's own messages (brief, steer, retry note). */
export const AUTHOR_LEAD = "lead";
/** Author of an owner reply the lead relayed to a worker. */
export const AUTHOR_OWNER = "owner";
