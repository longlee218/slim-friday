/** Change or remove one bullet of this channel's MEMORY.md (hardening round of memory v2). */
export const MEMORY_EDIT_TOOL = "MemoryEdit";

/** Actions of `MemoryEdit`: remove the bullet, or put new text in its place. */
export const MEMORY_EDIT_ACTIONS = ["delete", "replace"] as const;

/** `MemoryEdit` calls allowed per SDK query (the counter lives in the server built for ONE run; the next call is refused). */
export const MEMORY_EDIT_MAX_CALLS_PER_RUN = 20;
