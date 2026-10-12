import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { realOrSame } from "../guardrails/paths";
import type { Repo } from "../repos/repo-registry";
import { entryRole, followUpRole, getRole, isGated, ROLES } from "../roles/role-registry";
import { latestTurnSession, setTurnStatus, turnRole } from "../storage/run-store";
import type { SessionRow } from "../storage/session-store";
import { getWorktreeByThread, liveWorktree, type WorktreeRow } from "../storage/worktree-store";
import { resumeFailedPlan } from "./dispatch/resume-failed-task";
import {
  cappedTaskBlocker,
  capRefusal,
  findRepo,
  type Refusal,
  refuse,
  unknownRepo,
} from "./dispatch/task-repo";
import { type MessageCommand, RESUME_PROMPT } from "./message-commands";

/** Which role runs a message and where, decided before anything is created. */
export interface Route {
  /** Repo the thread is pinned to (or hinted with `repo:`), when any. */
  pinned?: Repo;
  /** Existing worktree of the thread (follow-up of a staged task). */
  worktree?: WorktreeRow;
  /** Role that runs the message: a follow-up in a live worktree -> the role that owns it; a plan-stage Resume -> its role; else the entry role. */
  role: string;
  /** Gated (staged) roles: repos the plan may pick from (managed clones only). */
  candidates: Repo[];
  /** Name for the turn row: the worktree's, the hinted repo's, else "*" (not chosen yet). */
  repo: string;
}

/**
 * Decide how a message is run: pinned repo, the role (from data, see `Route.role`), candidate repos, or a
 * refusal (unknown repo, empty text, no approval flow, no clone, too many capped tasks). `p.role` = the intent
 * layer's pick: it replaces the entry / worktree-owner choice, and the thread's clone is used only by the role
 * that owns it (an assistant answer in a thread with a clone never touches the clone).
 */
export function routeMessage(
  deps: { db: Database; agentHome: string; hasApprovals: boolean },
  p: {
    cmd: Extract<MessageCommand, { kind: "message" }>;
    threadId: string;
    repos: Repo[];
    existing: SessionRow | null;
    /** Role the intent layer picked; missing = the legacy pick (worktree owner, else the entry role). */
    role?: string;
  },
): Route | Refusal {
  const { cmd, repos, existing } = p;
  const hint = cmd.repo?.toLowerCase();
  const pinned = hint ? findRepo(repos, hint) : repos.find((r) => r.name === existing?.repo); // thread stays on its pinned repo
  if (cmd.repo && !pinned) return unknownRepo(repos, cmd.repo);
  if (cmd.repo && !cmd.text)
    return refuse("empty_text", `Send your question after "repo:${pinned!.name}".`);
  // A staged role runs only as a follow-up in a thread with a worktree (its owner role continues) or as the
  // Resume of an interrupted plan stage (`cmd.role`, starts fresh); every other message goes to the entry role.
  const live = cmd.role ? undefined : (liveWorktree(deps.db, p.threadId) ?? undefined);
  const owner = live ? (turnRole(deps.db, live.taskId) ?? followUpRole().name) : undefined;
  const role = getRole(cmd.role ?? p.role ?? owner ?? entryRole().name);
  const worktree = live && owner === role.name ? live : undefined;
  if (!isGated(role)) return { pinned, role: role.name, candidates: [], repo: pinned?.name ?? "*" };
  if (!deps.hasApprovals)
    return refuse("no_approvals", "This task needs the Discord approval flow.");
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
        role: role.name,
        candidates: repos,
        repo: worktree.repo,
      }
    );
  }
  const blocked = cappedTaskBlocker(deps.db, repos, cmd.repo);
  if ("reply" in blocked) return blocked;
  return {
    pinned,
    role: role.name,
    candidates: blocked.candidates,
    repo: cmd.repo ? (pinned?.name ?? "*") : "*",
  };
}

/** Refusal reasons after which a `go` message is treated as plain text (nothing to start or resume). */
export const PLAIN_GO: ReadonlySet<string> = new Set(["cannot_resume", "stale_resume"]);

/** A runnable command plus what a Resume adds. */
export interface ResumePlan {
  cmd: Extract<MessageCommand, { kind: "message" }>;
  /** Session to resume instead of the thread's stored one (Resume: the interrupted task's own). */
  existing?: SessionRow;
  /** Plan stage cut before approval: resume this session in its scratch dir. */
  planResume?: { sessionId: string; cwd: string };
  approved?: { plan: string; repo: string }; // failed_resumable task: the plan to run exec from again
}

/**
 * Make the owner's command runnable. A message passes through; the Resume button continues the latest
 * task of the thread, using the session that task recorded at init:
 * live worktree (cwd matches) -> follow-up there; plan scratch dir (still present) -> plan run of the same role;
 * the workspace `cwd` dir or one of its repos -> a plain message. Anything else (no session, cwd not usable, or the thread
 * already moved on) -> a reply.
 */
export function resolveCommand(
  deps: { db: Database; agentHome: string; workspace: string; repos: Repo[] },
  cmd: Exclude<MessageCommand, { kind: "stop" | "cleanup" | "memory" | "go" }>,
  threadId: string,
): ResumePlan | Refusal {
  if (cmd.kind !== "resume") return { cmd };
  const cannot = refuse(
    "cannot_resume",
    "Cannot resume: no saved session for this thread. Start the task again.",
  );
  const last = latestTurnSession(deps.db, threadId);
  if (!last) return cannot;
  // Only a task that was cut short (or stopped, or ended on its budget, or failed resumable) can be resumed; a newer finished/failed one means stale.
  if (
    !["interrupted", "cancelled", "failed_resumable"].includes(last.status) &&
    !last.budgetStopped
  )
    return refuse("stale_resume", "This Resume is out of date: the thread has moved on.");
  // A budget stop with the same budget would stop again: the owner must raise it.
  if (last.budgetStopped && last.status !== "interrupted" && cmd.extraBudgetUsd === undefined)
    return refuse(
      "budget_stop",
      "That task stopped on its budget. Reply `/go +<usd>` to continue with more budget.",
    );
  if (last.status === "failed_resumable") return resumeFailedPlan(deps, threadId);
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
  // The task ran in a clone that is gone (removed, cleaned up, or lost): nothing to continue, the task fails.
  const gone = worktree ? undefined : getWorktreeByThread(deps.db, threadId);
  // The clone dir is gone, so its own real path cannot be resolved: resolve the parent (the session stored a real cwd).
  if (
    gone?.baseSha != null &&
    existing.cwd === join(realOrSame(dirname(gone.path)), basename(gone.path))
  ) {
    setTurnStatus(deps.db, last.id, "failed");
    return refuse(
      "clone_missing",
      "Cannot resume: the task clone is gone (removed or cleaned up). The task is marked failed. Start it again.",
    );
  }
  if (worktree)
    return existing.cwd === realOrSame(worktree.path)
      ? { cmd: { kind: "message", text }, existing }
      : cannot;
  // Plan stage: its session cwd is the task scratch dir under <workspace>/tasks.
  const ws = workspacePaths(deps.agentHome).workspace(deps.workspace);
  if (existing.cwd.startsWith(`${realOrSame(ws.tasks)}/`)) {
    if (!existsSync(existing.cwd)) return cannot;
    return {
      cmd: { kind: "message", role: last.role, text },
      existing,
      planResume: { sessionId: existing.session_id, cwd: existing.cwd },
    };
  }
  // A staged role's exec session runs in the repo itself (no clone since Rev 15): resumed as a plain message it would run
  // the entry role on it. An interrupted exec with an approved plan runs again from that plan (fresh session, like a
  // failed one); without a plan the owner sends the request again.
  const owner = ROLES[last.role];
  if (owner && isGated(owner)) {
    if (last.status === "interrupted" && last.repo !== "*")
      return resumeFailedPlan(deps, threadId, true);
    return refuse(
      "cannot_resume",
      "Cannot resume: that task ran in the repo and its session cannot be continued here. Send the request again.",
    );
  }
  // A plain message only resumes in the workspace cwd dir or one of its repos; else the context would be lost.
  const plainCwd = existing.cwd === ws.cwd || deps.repos.some((r) => r.path === existing.cwd);
  return plainCwd ? { cmd: { kind: "message", text }, existing } : cannot;
}

export { runRoute } from "./run-route";
