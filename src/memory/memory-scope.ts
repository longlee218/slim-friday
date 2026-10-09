import type { Database } from "bun:sqlite";
import { liveWorktree } from "../storage/worktree-store";
import type { Workspace } from "../workspaces/workspace-registry";
import type { MemoryScope } from "./memory-commands";
import { type MemoryTarget, repoTarget, rootTarget, workspaceTarget } from "./memory-targets";

/** Where a command was typed, which decides the scopes it may use. */
export type MemoryPlace = "workspace" | "control";

/** What scope resolution knows about the message. */
export interface ScopeInput {
  db: Database;
  home: string;
  /** Workspace of the channel (absent in the control channel: only `global` is possible there). */
  ws?: Workspace;
  /** Thread the command was typed in; undefined for a plain channel message. */
  threadId?: string;
  place: MemoryPlace;
}

/** Latest task of the thread that had a real repo chosen ("*" = none yet). */
function latestTaskRepo(db: Database, threadId: string): string | undefined {
  return db
    .query<{ repo: string }, [string]>(
      `SELECT repo FROM tasks WHERE thread_id = ? AND repo != '*'
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(threadId)?.repo;
}

/** Names of the repos, for refusal texts. */
const names = (ws: Workspace): string => ws.repos.map((r) => `\`${r.name}\``).join(", ");

/**
 * Turn a scope into one memory file. Names come from the registry only (user text is compared, never joined
 * into a path). Default scope: the repo of the thread's live worktree, else of its latest task, else the
 * workspace's only repo; otherwise the owner is asked to name one.
 */
export function resolveMemoryTarget(
  i: ScopeInput,
  scope: MemoryScope,
): MemoryTarget | { reply: string } {
  if (i.place === "control") {
    return scope.kind === "global"
      ? rootTarget(i.home)
      : {
          reply:
            "In #ops-control only the global memory can be changed: `remember: global <text>`.",
        };
  }
  const { ws } = i;
  if (!ws) return { reply: "This channel is not linked to a workspace." };
  if (scope.kind === "global") return rootTarget(i.home);
  if (scope.kind === "workspace") return workspaceTarget(i.home, ws.name);
  const inWs = (name: string | undefined) => ws.repos.find((r) => r.name === name)?.name;
  if (scope.kind === "repo") {
    const hit = ws.repos.find((r) => r.name.toLowerCase() === scope.name.toLowerCase());
    return hit
      ? repoTarget(i.home, ws.name, hit.name)
      : { reply: `Unknown repo \`${scope.name}\` in workspace ${ws.name}. Repos: ${names(ws)}.` };
  }
  const fromThread = i.threadId
    ? (inWs(liveWorktree(i.db, i.threadId)?.repo) ?? inWs(latestTaskRepo(i.db, i.threadId)))
    : undefined;
  const only = ws.repos.length === 1 ? ws.repos[0]?.name : undefined;
  const repo = fromThread ?? only;
  return repo
    ? repoTarget(i.home, ws.name, repo)
    : { reply: `Which repo? \`remember: repo:<name> ...\`. Repos: ${names(ws)}.` };
}
