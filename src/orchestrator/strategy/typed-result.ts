import type { ResultKind } from "../../storage/owned-item-store";
import type { TaskState } from "../../tasks/task-contracts";

/* Typed worker results: what a worker's report means for the owned task. Pure. */

/** Result kinds a worker may report (the same set the db column stores). */
export const RESULT_KINDS: readonly ResultKind[] = [
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "NEEDS_PLANNING",
  "NEEDS_CLARIFICATION",
];

/** Task status a reported result kind settles the item to. */
export const STATUS_OF_RESULT: Readonly<Record<ResultKind, TaskState["status"]>> = {
  COMPLETED: "completed",
  FAILED: "failed",
  BLOCKED: "blocked",
  NEEDS_PLANNING: "blocked", // released by the plan flow, not by the owner
  NEEDS_CLARIFICATION: "waiting_user",
};
