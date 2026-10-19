/** Description the model reads for the `RetryTask` tool. */
export const RETRY_TASK_DESCRIPTION =
  "Retry a held task: a task that failed and waits for your decision (its failure event says so). It resumes its own " +
  "session and sees your note, its dependents stay waiting. Refused with NOT_HELD when the task is not held, ENDED when " +
  "it already finished, BREAKER after 3 dispatches, VERIFY_LOOP_CAP for a verify item that ran and reported FAILED after the last fix loop (ask the owner instead; a verify that crashed stays retryable), OVER_BUDGET when the goal budget is used up. The note says what to fix or change; the worker verifies its state " +
  "before it repeats a step. To give up instead, call CancelTask. An item cancelled with DEAD_DEPENDENCY is ended, not held: RequestPlan with the goalId if the work is still wanted.";
