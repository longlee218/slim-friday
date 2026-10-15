import type { ResultKind } from "../../storage/owned-item-store";
import type { TaskState } from "../../tasks/task-contracts";

/* Typed worker results: what a worker's report (or its absence) means for the owned task. Pure. */

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

/** Settled outcome of a worker run: the status and, when known, the kind to store. */
export interface DerivedResult {
  status: TaskState["status"];
  kind?: ResultKind;
}

/** What the engine knows about a run that ended without a ReportResult call. */
export interface RunFacts {
  /** The run ended `success` (no error, not stopped). */
  success: boolean;
  /** The run left evidence of its work (a non-empty reply, or the delivery evidence the role needs). */
  evidence: boolean;
  /** The run stopped on a question the owner has not answered. */
  pendingAsk: boolean;
}

/**
 * Derive the result when the worker did not report: a pending ask waits for the owner (NEEDS_CLARIFICATION), success
 * with evidence is COMPLETED, a failed run is FAILED. Success without evidence settles to `waiting_user` with no
 * kind (nothing was delivered; same as the existing "undelivered" rule).
 */
export function deriveResult(f: RunFacts): DerivedResult {
  if (f.pendingAsk) return { status: "waiting_user", kind: "NEEDS_CLARIFICATION" };
  if (!f.success) return { status: "failed", kind: "FAILED" };
  if (f.evidence) return { status: "completed", kind: "COMPLETED" };
  return { status: "waiting_user" };
}

/** Result of a run: the worker's report wins; a missing one is derived from the run facts. */
export function settleResult(kind: ResultKind | undefined, facts: RunFacts): DerivedResult {
  return kind ? { status: STATUS_OF_RESULT[kind], kind } : deriveResult(facts);
}
