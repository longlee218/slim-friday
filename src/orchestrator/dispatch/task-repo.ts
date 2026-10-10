import type { Database } from "bun:sqlite";
import { isManagedClone } from "../../repos/refresh-repo";
import type { Repo } from "../../repos/repo-registry";
import { countActiveCappedTasks } from "../../storage/run-store";

/** Max code tasks running or waiting for approval at once (RAM/quota; spike Q12). */
export const MAX_CODE_TASKS = 2;

/** A task that cannot start: `reason` is logged (`event` names it), `reply` goes to the owner. */
export interface Refusal {
  event: "task.refused" | "task.busy";
  reason: string;
  reply: string;
}

/** Refusal helper (keeps the call sites one line). */
export const refuse = (
  reason: string,
  reply: string,
  event: Refusal["event"] = "task.refused",
): Refusal => ({ event, reason, reply });

/** Refusal for a repo name that is not in the workspace (lists the available ones). */
export const unknownRepo = (repos: Repo[], name: string): Refusal => {
  const names = repos.map((r) => r.name).join(", ");
  return refuse("unknown_repo", `Unknown repo "${name}". Available: ${names}`);
};

/** The repo of `repos` called `name` (case-insensitive), or undefined. */
export const findRepo = (repos: Repo[], name: string): Repo | undefined =>
  repos.find((r) => r.name.toLowerCase() === name.toLowerCase());

/** Refusal when `MAX_CODE_TASKS` capped tasks already run or wait for approval, else undefined. */
export function capRefusal(db: Database): Refusal | undefined {
  return countActiveCappedTasks(db) >= MAX_CODE_TASKS
    ? refuse(
        "code_task_limit",
        `busy, ${MAX_CODE_TASKS} code tasks running, try again later`,
        "task.busy",
      )
    : undefined;
}

/**
 * THE single repo resolver (B2): routing, the `DelegateTask` pre-check and the dispatcher's validation all
 * go through it. `repoName` picks one repo of the workspace (unknown name -> refusal); else every managed
 * clone is a candidate. Worktrees branch off managed clones only, never a developer's working copy.
 */
export function resolveTaskRepo(
  agentHome: string,
  repos: Repo[],
  repoName?: string,
): Refusal | { candidates: Repo[] } {
  const picked = repoName ? findRepo(repos, repoName) : undefined;
  if (repoName && !picked) return unknownRepo(repos, repoName);
  const candidates = (picked ? [picked] : repos).filter((r) => isManagedClone(r.path, agentHome));
  if (candidates.length === 0) {
    return refuse(
      "no_clone",
      "Code tasks need a workspace clone (workspaces/<ws>/repos/<name>/repo, with a repo.yaml next to it). Clone the repo there first.",
    );
  }
  return { candidates };
}

/** Can a new code task start now? `resolveTaskRepo` plus the concurrency cap (shared by routing, the tool and dispatch). */
export function codeTaskBlocker(
  db: Database,
  agentHome: string,
  repos: Repo[],
  repoName?: string,
): Refusal | { candidates: Repo[] } {
  const r = resolveTaskRepo(agentHome, repos, repoName);
  return "reply" in r ? r : (capRefusal(db) ?? r);
}
