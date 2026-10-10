import { ensureHome } from "../memory/persona";
import { loadWorkspaces, type Workspace } from "./workspace-registry";

/** A task that cannot be placed in a workspace: `reason` is logged, `reply` goes to the owner. */
export interface WorkspaceRefusal {
  reason: "unmapped_channel" | "no_repos" | "legacy_layout";
  reply: string;
}

/**
 * The workspace whose `channels:` list holds `channelId` (the parent channel of a thread, or the channel of a
 * new conversation). Exactly one match or undefined: duplicates were already dropped by the registry, and
 * there is no default workspace.
 */
export function resolveTaskWorkspace(
  workspaces: Workspace[],
  channelId: string,
): Workspace | undefined {
  const hits = workspaces.filter((w) => w.channels.includes(channelId));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Scan the workspaces (re-read per task so yaml edits apply at once), create their missing files (never
 * overwrites) and route `channelId` to its workspace. Refuses (reply + reason) when the channel is unmapped,
 * the workspace has no repo, or only the pre-Step-B per-repo layout exists (migration pointer).
 */
export function selectWorkspace(
  agentHome: string,
  channelId: string,
): { ws: Workspace } | WorkspaceRefusal {
  const scan = loadWorkspaces(agentHome);
  ensureHome(agentHome, scan.workspaces);
  const ws = resolveTaskWorkspace(scan.workspaces, channelId);
  if (ws) {
    if (ws.repos.length > 0) return { ws };
    return {
      reason: "no_repos",
      reply: `Workspace ${ws.name} has no repos. Add workspaces/${ws.name}/repos/<name>/repo.yaml.`,
    };
  }
  if (scan.legacy.length > 0 && scan.workspaces.length === 0)
    return {
      reason: "legacy_layout",
      reply: "Old workspace layout found: see the cutover runbook (docs/discord-setup.md).",
    };
  return {
    reason: "unmapped_channel",
    reply: `This channel is not linked to a workspace. Add its id \`${channelId}\` to \`channels:\` in workspaces/<ws>/workspace.yaml (or run \`/init-workspace <name>\` in #ops-control).`,
  };
}
