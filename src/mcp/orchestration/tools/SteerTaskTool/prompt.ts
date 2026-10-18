/** Description the model reads for the `SteerTask` tool. */
export const STEER_TASK_DESCRIPTION =
  "Send the owner's follow-up text to one running task. Result: queued (taken by the run), held (the run is " +
  "starting), full (too many pending), ended (no run takes it), answered (it answered the worker's pending question) or " +
  "resumed (the task was waiting for the owner and has no run: the text is its answer and it starts again). A held (blocked) task " +
  "is refused with HELD: retry it with the text as the retry note instead.";
