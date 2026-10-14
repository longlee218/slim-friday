import type { Database } from "bun:sqlite";
import { pendingProposal } from "../../storage/proposal-store";
import { lastRunOutcome } from "../../storage/run-metrics-store";
import { dropResumable } from "../../storage/run-store";
import { RESUMABLE, type ResumeReason, resumeQuestion } from "../turns/turn-result";
import { type Refusal, refuse } from "./task-location";

/* `failed_resumable` (Rev 12): a background run that failed with its session saved (budget, transient error) keeps it.
   `/go`, or a yes to the question below, continues that session (same cwd) with a "continue" prompt; `/go +usd` also
   raises the budget. Only the thread's LAST task can be resumed. */

/** The thread's last task, when it is a resumable failure. */
export interface FailedResumable {
  id: string;
  role: string;
  /** Owner request of the task (stored redacted). */
  brief: string;
  /** Location of the task row: "*" until the run's final `location:` marker named one. */
  location: string;
  /** Why it stopped (the last run's outcome), when known. */
  reason?: ResumeReason;
}

/** The thread's last task if its status is `failed_resumable`, else undefined. */
export function failedResumable(db: Database, threadId: string): FailedResumable | undefined {
  const t = db
    .query<
      {
        id: string;
        role: string;
        status: string;
        brief: string | null;
        location: string;
      },
      [string]
    >(
      "SELECT id, role, status, brief, location FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(threadId);
  if (t?.status !== "failed_resumable") return undefined;
  return {
    id: t.id,
    role: t.role,
    brief: t.brief ?? "",
    location: t.location,
    reason: lastRunOutcome(db, t.id) === "max_budget" ? "budget" : "error",
  };
}

/** The unanswered question of a thread whose last task is resumable (what L3 reads the next message against). */
export function resumeQuestionOf(db: Database, threadId: string): string | undefined {
  const f = failedResumable(db, threadId);
  return f && resumeQuestion(f.id, f.reason ? RESUMABLE[f.reason] : "it did not get to run");
}

/** Reply of a "no" to the question: nothing is dropped, the owner decides later. */
export const RESUME_KEPT = "Kept. Send `/go` to continue that task later.";

/**
 * The owner answered the failed task's question. Yes -> the handler resumes it (a `run` outcome with `resume`); no -> a
 * reply, nothing is dropped. Undefined when this is not that question (busy thread, a proposal waits, no failed task).
 */
export function resumeAnswer(
  db: Database,
  threadId: string,
  answer: "yes" | "no",
  busy: boolean,
): { kind: "run"; role: string; resume: true } | { kind: "reply"; text: string } | undefined {
  const failed =
    !busy && !pendingProposal(db, threadId) ? failedResumable(db, threadId) : undefined;
  if (!failed) return undefined;
  return answer === "yes"
    ? { kind: "run", role: failed.role, resume: true }
    : { kind: "reply", text: RESUME_KEPT };
}

/**
 * Refusal for a thread whose resumable task has no session left to continue: the task becomes `failed` (nothing is left
 * to continue), the owner starts it again.
 */
export function resumeGone(db: Database, threadId: string): Refusal {
  dropResumable(db, threadId);
  return refuse(
    "resume_gone",
    "Cannot continue: the task has no saved session any more. The task is marked failed. Start it again.",
  );
}
