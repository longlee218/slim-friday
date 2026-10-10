import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Route as ModelRoute, TaskClass } from "../config/model-routing";
import { workspacePaths } from "../config/workspace-paths";
import { realOrSame } from "../guardrails/paths";
import type { Repo } from "../repos/repo-registry";
import { ASSISTANT_ROLE } from "../roles/builtin/assistant-role";
import { DEV_ROLE } from "../roles/builtin/dev-role";
import { latestTaskSession } from "../storage/run-store";
import type { SessionRow } from "../storage/session-store";
import { liveWorktree, type WorktreeRow } from "../storage/worktree-store";
import {
  capRefusal,
  codeTaskBlocker,
  findRepo,
  type Refusal,
  refuse,
  unknownRepo,
} from "./dispatch/task-repo";
import { RESUME_PROMPT, type TaskCommand } from "./task-commands";

/** Where a Q&A or code task runs, decided before anything is created. */
export interface Route {
  /** Repo the thread is pinned to (or hinted with `repo:`), when any. */
  pinned?: Repo;
  /** Existing worktree of the thread (follow-up of a code task). */
  worktree?: WorktreeRow;
  /** Role that runs the message: the dev role for code (a task or a follow-up in a worktree), else the assistant. */
  role: string;
  /** Code tasks: repos the plan may pick from (managed clones only). */
  candidates: Repo[];
  /** Name for the task row: the worktree's, the hinted repo's, else "*" (not chosen yet). */
  repo: string;
}

/**
 * Decide how a Q&A / code message is run: pinned repo, code or Q&A, candidate repos, or a refusal
 * (unknown repo, empty text, no approval flow, no clone, too many code tasks).
 */
export function routeTask(
  deps: { db: Database; agentHome: string; hasApprovals: boolean },
  p: {
    cmd: Extract<TaskCommand, { kind: "code" | "qa" }>;
    threadId: string;
    repos: Repo[];
    existing: SessionRow | null;
  },
): Route | Refusal {
  const { cmd, repos, existing } = p;
  const hint = cmd.repo?.toLowerCase();
  const pinned = hint ? findRepo(repos, hint) : repos.find((r) => r.name === existing?.repo); // thread stays on its pinned repo
  if (cmd.repo && !pinned) return unknownRepo(repos, cmd.repo);
  if (cmd.repo && !cmd.text)
    return refuse("empty_text", `Send your question after "repo:${pinned!.name}".`);
  // Code only for a follow-up in a thread with a worktree, or the Resume of an interrupted plan stage.
  const worktree =
    cmd.kind === "code" ? undefined : (liveWorktree(deps.db, p.threadId) ?? undefined);
  const isCode = cmd.kind === "code" || !!worktree;
  if (!isCode)
    return { pinned, role: ASSISTANT_ROLE.name, candidates: [], repo: pinned?.name ?? "*" };
  if (!deps.hasApprovals)
    return refuse("no_approvals", "Code tasks need the Discord approval flow.");
  if (!cmd.text) return refuse("empty_text", "Send a message with the task.");
  // A follow-up reuses its worktree: only the task cap applies. A plan resume re-checks clone + cap.
  if (worktree) {
    // The channel's workspace must own this worktree's clone (a remapped channel must not touch it).
    if (!repos.some((r) => realOrSame(r.path) === realOrSame(worktree.repoPath)))
      return refuse(
        "wrong_workspace",
        `This thread's worktree belongs to repo ${worktree.repo}, which is not in this channel's workspace. Re-link the channel, or clean up the thread.`,
      );
    return (
      capRefusal(deps.db) ?? {
        pinned,
        worktree,
        role: DEV_ROLE.name,
        candidates: repos,
        repo: worktree.repo,
      }
    );
  }
  const blocked = codeTaskBlocker(deps.db, deps.agentHome, repos, cmd.repo);
  if ("reply" in blocked) return blocked;
  return {
    pinned,
    role: DEV_ROLE.name,
    candidates: blocked.candidates,
    repo: cmd.repo ? (pinned?.name ?? "*") : "*",
  };
}

/** Refusal reasons after which a `go` message is treated as plain text (nothing to start or resume). */
export const PLAIN_GO: ReadonlySet<string> = new Set(["cannot_resume", "stale_resume"]);

/** A runnable command (code or Q&A) plus what a Resume adds. */
export interface ResumePlan {
  cmd: Extract<TaskCommand, { kind: "code" | "qa" }>;
  /** Session to resume instead of the thread's stored one (Resume: the interrupted task's own). */
  existing?: SessionRow;
  /** Plan stage cut before approval: resume this session in its scratch dir. */
  planResume?: { sessionId: string; cwd: string };
}

/**
 * Make the owner's command runnable. Q&A / code pass through; the Resume button continues the latest
 * task of the thread, using the session that task recorded at init:
 * live worktree (cwd matches) -> follow-up there; plan scratch dir (still present) -> plan run;
 * the workspace `cwd` dir or one of its repos -> Q&A. Anything else (no session, cwd not usable, or the thread
 * already moved on) -> a reply.
 */
export function resolveCommand(
  deps: { db: Database; agentHome: string; workspace: string; repos: Repo[] },
  cmd: Exclude<TaskCommand, { kind: "stop" | "cleanup" | "memory" | "go" }>,
  threadId: string,
): ResumePlan | Refusal {
  if (cmd.kind !== "resume") return { cmd };
  const cannot = refuse(
    "cannot_resume",
    "Cannot resume: no saved session for this thread. Start the task again.",
  );
  const last = latestTaskSession(deps.db, threadId);
  if (!last) return cannot;
  // Only a task that was cut short (or stopped, or ended on its budget) can be resumed; a newer finished/failed one means stale.
  if (last.status !== "interrupted" && last.status !== "cancelled" && !last.budgetStopped)
    return refuse("stale_resume", "This Resume is out of date: the thread has moved on.");
  // A budget stop with the same budget would stop again: the owner must raise it.
  if (last.budgetStopped && last.status !== "interrupted" && cmd.extraBudgetUsd === undefined)
    return refuse(
      "budget_stop",
      "That task stopped on its budget. Reply `go +<usd>` to continue with more budget.",
    );
  if (!last.sessionId || !last.cwd) return cannot;
  const existing: SessionRow = {
    thread_id: threadId,
    session_id: last.sessionId,
    repo: last.repo,
    cwd: last.cwd,
    status: "active",
    updated_at: Date.now(),
  };
  const text = RESUME_PROMPT;
  const worktree = liveWorktree(deps.db, threadId);
  if (worktree)
    return existing.cwd === realOrSame(worktree.path)
      ? { cmd: { kind: "qa", text }, existing }
      : cannot;
  // Plan stage: its session cwd is the task scratch dir under <workspace>/tasks.
  const ws = workspacePaths(deps.agentHome).workspace(deps.workspace);
  if (existing.cwd.startsWith(`${realOrSame(ws.tasks)}/`)) {
    if (!existsSync(existing.cwd)) return cannot;
    return {
      cmd: { kind: "code", text },
      existing,
      planResume: { sessionId: existing.session_id, cwd: existing.cwd },
    };
  }
  // Q&A: qa-flow only resumes in the workspace cwd dir or one of its repos; else the context would be lost.
  const qaCwd = existing.cwd === ws.cwd || deps.repos.some((r) => r.path === existing.cwd);
  return qaCwd ? { cmd: { kind: "qa", text }, existing } : cannot;
}

/** Route of a run: owner class and `go +<usd>` raise; undefined when neither is set (stage defaults). */
export const runRoute = (r: {
  cls?: TaskClass;
  extraBudgetUsd?: number;
}): ModelRoute | undefined =>
  r.cls || r.extraBudgetUsd ? { cls: r.cls, extraBudgetUsd: r.extraBudgetUsd } : undefined;
