import { CONTENT_MAX_CHARS, SPACE_FILES } from "./constants";

/** Description the model reads for the `WriteSpaceFile` tool. */
export const WRITE_SPACE_FILE_DESCRIPTION =
  `Replace one file of a space (or of one of its channels when \`channel\` is given): ${SPACE_FILES.join(", ")}. ` +
  `Give the WHOLE new content (max ${CONTENT_MAX_CHARS} chars, no secrets). The owner sees a diff and confirms with ` +
  "buttons; the old file is backed up. Nothing is written on a no or no answer, and the result says so. " +
  "Read the current file first when you edit rather than create.";
