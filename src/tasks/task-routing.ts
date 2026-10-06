import type { Database } from "bun:sqlite";
import { isManagedClone } from "../repos/refresh-repo";
import type { Repo } from "../repos/repo-registry";
import { countActiveCodeTasks } from "../storage/run-store";
import type { SessionRow } from "../storage/session-store";
import { liveWorktree, type WorktreeRow } from "../storage/worktree-store";
import type { TaskCommand } from "./task-commands";

/** Max code tasks running or waiting for approval at once (RAM/quota; spike Q12). */
const MAX_CODE_TASKS = 2;

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
  // Code task (`task:`) or follow-up in a thread that already has a worktree.
  const worktree =
    cmd.kind === "code" ? undefined : (liveWorktree(deps.db, p.threadId) ?? undefined);
  const isCode = cmd.kind === "code" || !!worktree;
  if (!isCode) return { pinned, isCode, candidates: [], repo: pinned?.name ?? "*" };
  if (!deps.hasApprovals)
    return refuse("no_approvals", "Code tasks need the Discord approval flow.");
  if (!cmd.text) return refuse("empty_text", "Send the task after `task:`.");
  // Worktrees branch off managed clones only, never a developer's working copy.
  // `repo:` is a hint for a task; there is no sticky pin.
  const picked = cmd.repo ? pinned : undefined;
  const candidates = (picked ? [picked] : repos).filter((r) =>
    isManagedClone(r.path, deps.agentHome),
  );
  if (!worktree && candidates.length === 0) {
    return refuse(
      "no_clone",
      "Code tasks need a workspace clone (workspaces/<name>/repo with a config.yaml). Clone the repo there first.",
    );
  }
  if (countActiveCodeTasks(deps.db) >= MAX_CODE_TASKS) {
    return refuse(
      "code_task_limit",
      `busy, ${MAX_CODE_TASKS} code tasks running, try again later`,
      "task.busy",
    );
  }
  return {
    pinned,
    worktree,
    isCode,
    candidates: worktree ? repos : candidates,
    repo: worktree?.repo ?? picked?.name ?? "*",
  };
}
