import { DIGEST_MAX_CHARS, TITLE_MAX_CHARS } from "./constants";

/** Description the model reads for the `SetThreadTitle` tool. */
export const SET_THREAD_TITLE_DESCRIPTION =
  "Name this thread and store a short digest of it. Call it ONCE, as soon as you know the topic of the conversation. " +
  "A greeting-only or empty turn (hello, thanks, ok) = do NOT call. " +
  `title: at most 6 words (max ${TITLE_MAX_CHARS} chars), in the owner's language. ` +
  `digest: 1-2 short lines on what the thread is about (max ${DIGEST_MAX_CHARS} chars). ` +
  "Never include secrets, tokens, passwords or keys in either field.";
