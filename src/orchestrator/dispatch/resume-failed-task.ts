import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../../config/workspace-paths";
import { ROLES } from "../../roles/role-registry";
import { pendingProposal } from "../../storage/proposal-store";
import { dropResumable } from "../../storage/run-store";
import { listStages } from "../../storage/stage-store";
import { planFileOf } from "../engine/resume-exec";
import type { ResumePlan } from "../message-routing";
import { RESUMABLE, type ResumeReason, resumeQuestion } from "../turns/turn-result";
import { type Refusal, refuse } from "./task-repo";

/* `failed_resumable` (Rev 12): a task that failed after the owner approved its plan (budget, transient error), or an
   exec cut short by a restart, keeps its saved plan. `/go`, or a yes to the question below, runs the exec stage again
   from the approved plan in the repo, on a fresh session. Only the thread's LAST task can be resumed. */

/** The thread's last task, when it is a resumable failure. */
export interface FailedResumable {
  id: string;
  role: string;
  /** Owner request of the task (stored redacted). */
  brief: string;
  /** Repo of the task row: "*" until a plan picked one (`switchToExec` sets it when the plan is approved). */
  repo: string;
  /** Why it stopped (the failed stage's verdict), when known. */
  reason?: ResumeReason;
}

/** The thread's last task if its status is `failed_resumable`, else undefined. */
export function failedResumable(
  db: Database,
  threadId: string,
  allowInterrupted = false,
): FailedResumable | undefined {
  const t = db
    .query<
      {
        id: string;
        role: string;
        status: string;
        brief: string | null;
        repo: string;
      },
      [string]
    >(
      "SELECT id, role, status, brief, repo FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(threadId);
  // `interrupted` (a restart mid-exec) counts when the caller asks and the plan was approved (the stage switch set the repo).
  if (
    t?.status !== "failed_resumable" &&
    !(allowInterrupted && t?.status === "interrupted" && t.repo !== "*")
  )
    return undefined;
  const verdict = listStages(db, t.id)
    .map((s) => s.verdict)
    .reverse()
    .find((v): v is ResumeReason => !!v && v in RESUMABLE);
  return {
    id: t.id,
    role: t.role,
    brief: t.brief ?? "",
    repo: t.repo,
    reason: verdict,
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
 * What the exec stage needs to run again: the original request, the approved plan read from the plan file the stage
 * switch saved in the task's scratch dir, and the repo. The session is never resumed (fresh session, the handoff
 * carries the plan). A refusal when the plan file is gone: the task then becomes `failed` (nothing is left to continue).
 */
export function resumeFailedPlan(
  d: { db: Database; agentHome: string; workspace: string },
  threadId: string,
  allowInterrupted = false,
): ResumePlan | Refusal {
  const f = failedResumable(d.db, threadId, allowInterrupted);
  const gone = () => {
    dropResumable(d.db, threadId);
    return refuse(
      "resume_gone",
      "Cannot continue: the approved plan is gone. The task is marked failed. Start it again.",
    );
  };
  if (!f) return refuse("stale_resume", "This Resume is out of date: the thread has moved on.");
  const role = ROLES[f.role];
  if (!role || f.repo === "*") return gone();
  let plan: string;
  try {
    const dir = workspacePaths(d.agentHome).workspace(d.workspace).task(f.id).root;
    plan = readFileSync(join(dir, planFileOf(role)), "utf8");
  } catch {
    return gone();
  }
  return {
    // The role is named: the thread's entry role would run it otherwise.
    cmd: { kind: "message", text: f.brief || "Continue the approved plan.", role: f.role },
    approved: { plan, repo: f.repo },
  };
}
