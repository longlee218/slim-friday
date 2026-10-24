import { MEMORY_NOTE_MAX_CHARS } from "../../sanitize-bullet";

/** Description the model reads for `MemoryEdit`. */
export const MEMORY_EDIT_DESCRIPTION =
  "Change your notes. With no id: list the notes with their ids. With id and text: replace that note. With id and delete: true: remove it. " +
  `scope: bot (default) or group (the group conversation you answer now). Text is one line of at most ${MEMORY_NOTE_MAX_CHARS} characters. Returns the list, replaced, deleted, not_found, empty, too_long or busy.`;
