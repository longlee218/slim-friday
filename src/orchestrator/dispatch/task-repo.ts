import type { Database } from "bun:sqlite";
import type { Repo } from "../../repos/repo-registry";
import { countActiveCappedTasks } from "../../storage/run-store";

/** Max capped tasks (roles with `countsTowardCap`) running or waiting for approval at once (RAM/quota; spike Q12). */
export const MAX_CAPPED_TASKS = 10;

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

/** Refusal when `MAX_CAPPED_TASKS` capped tasks already run or wait for approval, else undefined. */
export function capRefusal(db: Database): Refusal | undefined {
  return countActiveCappedTasks(db) >= MAX_CAPPED_TASKS
    ? refuse(
        "code_task_limit",
        `busy, ${MAX_CAPPED_TASKS} tasks running, try again later`,
        "task.busy",
      )
    : undefined;
}

/**
 * THE single repo resolver (B2): routing and the dispatcher's validation both
 * go through it. `repoName` picks one repo of the workspace (unknown name -> refusal); else every registered
 * repo is a candidate. Any registered repo works.
 */
export function resolveTaskRepo(
  repos: Repo[],
  repoName?: string,
): Refusal | { candidates: Repo[] } {
  const picked = repoName ? findRepo(repos, repoName) : undefined;
  if (repoName && !picked) return unknownRepo(repos, repoName);
  return { candidates: picked ? [picked] : repos };
}

/** Can a new capped task start now? `resolveTaskRepo` plus the concurrency cap (shared by routing and dispatch). */
export function cappedTaskBlocker(
  db: Database,
  repos: Repo[],
  repoName?: string,
): Refusal | { candidates: Repo[] } {
  const r = resolveTaskRepo(repos, repoName);
  return "reply" in r ? r : (capRefusal(db) ?? r);
}
