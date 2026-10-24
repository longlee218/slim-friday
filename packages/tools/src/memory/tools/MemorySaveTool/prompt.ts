import { MEMORY_NOTE_MAX_CHARS } from "../../sanitize-bullet";

/** Description the model reads for `MemorySave`. */
export const MEMORY_SAVE_DESCRIPTION =
  "Save one durable note: a decision, fact, preference or lesson worth keeping across sessions. " +
  "scope: bot = your own MEMORY.md (default); group = the MEMORY.md of the group conversation you answer now, read by every member. " +
  `Stored as one plain line of at most ${MEMORY_NOTE_MAX_CHARS} characters (a longer note is refused, never cut). Returns saved, duplicate, empty, too_long or busy; never say a note is saved unless this returned saved.`;
