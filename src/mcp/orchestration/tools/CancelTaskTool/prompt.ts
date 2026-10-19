/** Description the model reads for the `CancelTask` tool. */
export const CANCEL_TASK_DESCRIPTION =
  "Cancel one task: its run is aborted and every task that depends on it is cancelled. Refused with ENDED when the " +
  "task already finished. Give a short reason. Cancelling a planner item keeps its plan valid for ApprovePlan; cancelling a goal closes the goal's pending plan.";
