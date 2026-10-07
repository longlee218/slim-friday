import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { realOrSame } from "../guardrails/paths";
import { isManagedClone } from "../repos/refresh-repo";
import type { Repo } from "../repos/repo-registry";
import { countActiveCodeTasks, latestTaskSession } from "../storage/run-store";
import type { SessionRow } from "../storage/session-store";
import { liveWorktree, type WorktreeRow } from "../storage/worktree-store";
import { RESUME_PROMPT, type TaskCommand } from "./task-commands";

/** Max code tasks running or waiting for approval at once (RAM/quota; spike Q12). */
export const MAX_CODE_TASKS = 2;

/** A task that cannot start: `reason` is logged (`event` names it), `reply` goes to the owner. */
export interface Refusal {
  event: "task.refused" | "task.busy";
  reason: string;
  reply: string;
}

/** Where a Q&A or code task runs, decided before anything is created. */
export interface Route {
  /** Repo the thread is pinned to (or hinted with `repo:`), when any. */
  pinned?: Repo;
  /** Existing worktree of the thread (follow-up of a code task). */
  worktree?: WorktreeRow;
  isCode: boolean;
  /** Code tasks: repos the plan may pick from (managed clones only). */
  candidates: Repo[];
  /** Name for the task row: the worktree's, the hinted repo's, else "*" (not chosen yet). */
  repo: string;
}

/** Refusal helper (keeps the call sites one line). */
const refuse = (
  reason: string,
  reply: string,
  event: Refusal["event"] = "task.refused",
): Refusal => ({
  event,
  reason,
  reply,
});

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
  const pinned = hint
    ? repos.find((r) => r.name.toLowerCase() === hint)
    : repos.find((r) => r.name === existing?.repo); // thread stays on its pinned repo
  if (cmd.repo && !pinned) {
    const names = repos.map((r) => r.name).join(", ");
    return refuse("unknown_repo", `Unknown repo "${cmd.repo}". Available: ${names}`);
  }
  if (cmd.repo && !cmd.text)
    return refuse("empty_text", `Send your question after "repo:${pinned!.name}".`);
  // Code only for a follow-up in a thread with a worktree, or the Resume of an interrupted plan stage.
  const worktree =
    cmd.kind === "code" ? undefined : (liveWorktree(deps.db, p.threadId) ?? undefined);
  const isCode = cmd.kind === "code" || !!worktree;
  if (!isCode) return { pinned, isCode, candidates: [], repo: pinned?.name ?? "*" };
  if (!deps.hasApprovals)
    return refuse("no_approvals", "Code tasks need the Discord approval flow.");
  if (!cmd.text) return refuse("empty_text", "Send a message with the task.");
  // A follow-up reuses its worktree: only the task cap applies. A plan resume re-checks clone + cap.
  if (worktree) {
    return (
      capRefusal(deps.db) ?? { pinned, worktree, isCode, candidates: repos, repo: worktree.repo }
    );
  }
  const blocked = codeTaskBlocker(deps.db, deps.agentHome, repos, cmd.repo);
  if ("reply" in blocked) return blocked;
  return {
    pinned,
    isCode,
    candidates: blocked.candidates,
    repo: cmd.repo ? (pinned?.name ?? "*") : "*",
  };
}

/** Refusal when `MAX_CODE_TASKS` code tasks already run or wait for approval, else undefined. */
function capRefusal(db: Database): Refusal | undefined {
  return countActiveCodeTasks(db) >= MAX_CODE_TASKS
    ? refuse(
        "code_task_limit",
        `busy, ${MAX_CODE_TASKS} code tasks running, try again later`,
        "task.busy",
      )
    : undefined;
}

/**
 * Can a new code task start now? Shared by routing, the `delegate` tool and the handoff (one rule).
 * `repoName` picks one repo (unknown name -> refusal); else every managed clone is a candidate.
 * Worktrees branch off managed clones only, never a developer's working copy.
 */
export function codeTaskBlocker(
  db: Database,
  agentHome: string,
  repos: Repo[],
  repoName?: string,
): Refusal | { candidates: Repo[] } {
  const hint = repoName?.toLowerCase();
  const picked = hint ? repos.find((r) => r.name.toLowerCase() === hint) : undefined;
  if (repoName && !picked) {
    const names = repos.map((r) => r.name).join(", ");
    return refuse("unknown_repo", `Unknown repo "${repoName}". Available: ${names}`);
  }
  const candidates = (picked ? [picked] : repos).filter((r) => isManagedClone(r.path, agentHome));
  if (candidates.length === 0) {
    return refuse(
      "no_clone",
      "Code tasks need a workspace clone (workspaces/<name>/repo with a config.yaml). Clone the repo there first.",
    );
  }
  return capRefusal(db) ?? { candidates };
}

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
 * home `cwd` dir or a registered repo -> Q&A. Anything else (no session, cwd not usable, or the thread
 * already moved on) -> a reply.
 */
export function resolveCommand(
  deps: { db: Database; agentHome: string; repos: Repo[] },
  cmd: Exclude<TaskCommand, { kind: "stop" | "cleanup" }>,
  threadId: string,
): ResumePlan | Refusal {
  if (cmd.kind !== "resume") return { cmd };
  const cannot = refuse(
    "cannot_resume",
    "Cannot resume: no saved session for this thread. Start the task again.",
  );
  const last = latestTaskSession(deps.db, threadId);
  if (!last) return cannot;
  // Only a task that was cut short (or stopped) can be resumed; a newer finished/failed one means stale.
  if (last.status !== "interrupted" && last.status !== "cancelled")
    return refuse("stale_resume", "This Resume is out of date: the thread has moved on.");
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
  // Plan stage: its session cwd is the task scratch dir under <home>/tasks.
  if (existing.cwd.startsWith(`${join(realOrSame(deps.agentHome), "tasks")}/`)) {
    if (!existsSync(existing.cwd)) return cannot;
    return {
      cmd: { kind: "code", text },
      existing,
      planResume: { sessionId: existing.session_id, cwd: existing.cwd },
    };
  }
  // Q&A: qa-flow only resumes in the neutral cwd dir or a registered repo; else the context would be lost.
  const qaCwd =
    existing.cwd === join(deps.agentHome, "cwd") || deps.repos.some((r) => r.path === existing.cwd);
  return qaCwd ? { cmd: { kind: "qa", text }, existing } : cannot;
}
