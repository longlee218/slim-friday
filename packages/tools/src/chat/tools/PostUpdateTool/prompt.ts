/** Description the model reads for `PostUpdate` (adapted from Rakazo's `message_user`, R§4). */
export const POST_UPDATE_DESCRIPTION =
  "Post a short progress update to the owner in this chat immediately. Does not end your turn. Use sparingly " +
  "during long work for high-signal beats (what you are checking, then a result). Do not dump tool logs, " +
  "thinking, or a play-by-play of every call. HARD LIMIT: cut off at 500 characters, so never put your final " +
  "answer, a report, or any long-form content here — it will arrive mangled and the owner will never see the " +
  "rest. Always write your complete final answer in your normal reply, not here.";

/** Result when the update was not posted (the run is under 60 s old, or 3 updates were posted already). */
export const POST_UPDATE_NOT_POSTED =
  "This update was not posted. The turn is still fresh, or the chat already has enough interim messages for " +
  "this run. Do not send more progress updates — keep working and put everything in your final reply.";

/** Result when the update was posted but cut at 500 characters. */
export const POST_UPDATE_CUT =
  "This progress update was cut off at 500 characters and the owner only saw the truncated version above — it " +
  "did NOT deliver your full content. PostUpdate is for short interim beats only, never the final answer. Put " +
  "your complete answer in your normal final reply instead of relying on this truncated update.";
