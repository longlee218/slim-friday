import type { Database } from "bun:sqlite";
import { relative, sep } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { realOrSame } from "../guardrails/paths";
import { ensureHome } from "../memory/persona";
import { liveWorktree } from "../storage/worktree-store";
import { loadWorkspaces, type Workspace } from "../workspaces/workspace-registry";

/**
 * The workspace a task runs in. Until channel routing exists: the workspace that owns the thread's live
 * worktree (a follow-up must stay where its worktree is), else the first workspace by name that has repos.
 */
export function pickWorkspace(
  agentHome: string,
  workspaces: Workspace[],
  worktreePath?: string,
): Workspace | undefined {
  if (worktreePath) {
    const rel = relative(
      realOrSame(workspacePaths(agentHome).workspaces),
      realOrSame(worktreePath),
    );
    const owner = workspaces.find((w) => w.name === rel.split(sep)[0]);
    if (owner) return owner;
  }
  return workspaces.find((w) => w.repos.length > 0);
}

/**
 * Scan the workspaces, create their missing files (never overwrites) and pick the one for this thread.
 * Refuses (reply + logged reason) when none has a repo; a legacy per-repo layout with no workspace gets
 * the migration pointer.
 */
export function selectWorkspace(
  agentHome: string,
  db: Database,
  threadId: string,
): { ws: Workspace } | { reason: string; reply: string } {
  const scan = loadWorkspaces(agentHome);
  ensureHome(agentHome, scan.workspaces);
  const ws = pickWorkspace(agentHome, scan.workspaces, liveWorktree(db, threadId)?.path);
  if (ws) return { ws };
  if (scan.legacy.length > 0 && scan.workspaces.length === 0)
    return {
      reason: "legacy_layout",
      reply: "Old workspace layout found: see the migration runbook (docs/discord-setup.md).",
    };
  return {
    reason: "no_workspace",
    reply: `No workspace found (with a repo). Add workspaces/<ws>/workspace.yaml and workspaces/<ws>/repos/<repo>/repo.yaml under ${agentHome}.`,
  };
}
