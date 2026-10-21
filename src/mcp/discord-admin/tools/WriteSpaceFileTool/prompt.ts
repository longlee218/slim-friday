import { CONTENT_MAX_CHARS, SPACE_FILES } from "./constants";

/** Description the model reads for the `WriteSpaceFile` tool. */
export const WRITE_SPACE_FILE_DESCRIPTION =
  `Replace one file of a space (or of one of its channels when \`channel\` is given): ${SPACE_FILES.join(", ")}. MEMORY.md exists only per channel (give \`channel\`). ` +
  `Give the WHOLE new content (no secrets; max ${CONTENT_MAX_CHARS} chars for each file except MEMORY.md, which has no size cap). The owner sees a diff and confirms with ` +
  "buttons; the old file is backed up. Nothing is written on a no or no answer, and the result says so.";
