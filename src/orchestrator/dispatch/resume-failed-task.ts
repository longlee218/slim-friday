import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../../config/workspace-paths";
import { ROLES } from "../../roles/role-registry";
import { pendingProposal } from "../../storage/proposal-store";
import { dropResumable } from "../../storage/run-store";
import type { SessionRow } from "../../storage/session-store";
import { listStages } from "../../storage/stage-store";
import { getWorktreeByTask, type WorktreeRow } from "../../storage/worktree-store";
import { planFileOf } from "../engine/resume-exec";
import type { ResumePlan } from "../message-routing";
import { RESUMABLE, type ResumeReason, resumeQuestion } from "../turns/turn-result";
import { type Refusal, refuse } from "./task-repo";

/* `failed_resumable` (Rev 12): a task that failed after the owner approved its plan (config refusal, budget, transient
   error) keeps its clone, saved plan and session. `/go`, or a yes to the question below, runs the exec stage again
   from the approved plan in the same clone. Only the thread's LAST task can be resumed; a newer task of the thread
   leaves the old clone held until retention or `/cleanup` removes it. */

/** The thread's last task, when it is a resumable failure. */
export interface FailedResumable {
  id: string;
  role: string;
  /** Owner request of the task (stored redacted). */
  brief: string;
  /** Repo of the task row: "*" until a plan picked one (a clone-less failure saved it, see engine/save-plan.ts). */
  repo: string;
  /** Task this run continued (its clone and plan file belong to that one), when it was a resume. */
  parent: string | null;
  sessionId: string | null;
  cwd: string | null;
  /** Why it stopped (the failed stage's verdict), when known. */
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
        repo: string;
        parent_turn_id: string | null;
        session_id: string | null;
        session_cwd: string | null;
      },
      [string]
    >(
      "SELECT id, role, status, brief, repo, parent_turn_id, session_id, session_cwd FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(threadId);
  if (t?.status !== "failed_resumable") return undefined;
  const verdict = listStages(db, t.id)
    .map((s) => s.verdict)
    .reverse()
    .find((v): v is ResumeReason => !!v && v in RESUMABLE);
  return {
    id: t.id,
    role: t.role,
    brief: t.brief ?? "",
    repo: t.repo,
    parent: t.parent_turn_id,
    sessionId: t.session_id,
    cwd: t.session_cwd,
    reason: verdict,
  };
}

/** The unanswered question of a thread whose last task is resumable (what L3 reads the next message against). */
export function resumeQuestionOf(db: Database, threadId: string): string | undefined {
  const f = failedResumable(db, threadId);
  return f && resumeQuestion(f.id, f.reason ? RESUMABLE[f.reason] : "it did not get to run");
}

/** Reply of a "no" to the question: nothing is dropped, the owner decides later. */
export const RESUME_KEPT =
  "Kept. Send `/go` to continue that task later, or `/cleanup` to drop its clone.";

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

/** The clone the failed task works in: its own, or its parent's (a resumed run that failed again), when it still exists. */
function cloneOf(db: Database, f: FailedResumable): WorktreeRow | "gone" | undefined {
  const row = getWorktreeByTask(db, f.id) ?? (f.parent ? getWorktreeByTask(db, f.parent) : null);
  if (!row) return undefined; // the stage switch never made one (no commit identity)
  return existsSync(row.path) ? row : "gone";
}

/**
 * What the exec stage needs to run again: the original request, the approved plan read from the saved plan file, the
 * repo, and (when the clone exists) the task's own session (the runner uses it only when its cwd is still the clone).
 * Without a clone the stage switch runs again and creates it. A refusal when the clone or the plan file is gone: the
 * task then becomes `failed` (nothing is left to continue).
 */
export function resumeFailedPlan(
  d: { db: Database; agentHome: string; workspace: string },
  threadId: string,
): ResumePlan | Refusal {
  const f = failedResumable(d.db, threadId);
  const gone = (what: string) => {
    dropResumable(d.db, threadId);
    return refuse(
      "resume_gone",
      `Cannot continue: ${what} is gone. The task is marked failed. Start it again.`,
    );
  };
  if (!f) return refuse("stale_resume", "This Resume is out of date: the thread has moved on.");
  const wt = cloneOf(d.db, f);
  if (wt === "gone") return gone("the task clone");
  const role = ROLES[f.role];
  const repo = wt?.repo ?? f.repo;
  if (!role || repo === "*") return gone("the approved plan");
  let plan: string;
  try {
    // The plan file belongs to the task that made the clone (a resumed run that failed again is a later row).
    const dir = workspacePaths(d.agentHome)
      .workspace(d.workspace)
      .task(wt?.taskId ?? f.id).root;
    plan = readFileSync(join(dir, planFileOf(role)), "utf8");
  } catch {
    return gone("the approved plan");
  }
  const existing: SessionRow | undefined =
    wt && f.sessionId && f.cwd
      ? {
          thread_id: threadId,
          session_id: f.sessionId,
          repo,
          cwd: f.cwd,
          status: "active",
          updated_at: Date.now(),
        }
      : undefined;
  return {
    // No clone: the role is named (the thread's latest clone, if any, is another task's).
    cmd: {
      kind: "message",
      text: f.brief || "Continue the approved plan.",
      ...(!wt && { role: f.role }),
    },
    existing,
    approved: { plan, repo },
  };
}
