import type { Location } from "../locations/location-registry";
import { ensureHome } from "../memory/persona";
import { loadWorkspaces, type Workspace, type WorkspaceChannel } from "./workspace-registry";

/** A task that cannot be placed in a workspace: `reason` is logged, `reply` goes to the owner. */
export interface WorkspaceRefusal {
  reason: "unmapped_channel";
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

/** The channel entry of `ws` for a Discord channel id (the registry guarantees a mapped id has one). */
export const channelOf = (ws: Workspace, channelId: string): WorkspaceChannel | undefined =>
  ws.channelDefs.find((c) => c.id === channelId);

/** Locations a run in `channel` may use: the channel's `locations` subset when set, else every location of the space. */
export const channelLocations = (ws: Workspace, channel: WorkspaceChannel): Location[] =>
  channel.locations
    ? ws.locations.filter((l) => channel.locations?.includes(l.name))
    : ws.locations;

/**
 * Scan the workspaces (re-read per task so yaml edits apply at once), create their missing files (never
 * overwrites) and route `channelId` to its workspace. Refuses (reply + reason) when the channel is unmapped. Returns the space and the channel entry (name, mode, locations). A workspace with no location is fine: it works in its `cwd/`.
 */
export function selectWorkspace(
  agentHome: string,
  channelId: string,
): { ws: Workspace; channel: WorkspaceChannel } | WorkspaceRefusal {
  const scan = loadWorkspaces(agentHome);
  ensureHome(agentHome, scan.workspaces);
  const ws = resolveTaskWorkspace(scan.workspaces, channelId);
  const channel = ws && channelOf(ws, channelId);
  if (ws && channel) return { ws, channel };
  return {
    reason: "unmapped_channel",
    reply: `This channel is not linked to a workspace. Add its id \`${channelId}\` to \`channels:\` in workspaces/<ws>/workspace.yaml (or run \`/teammate create <space> <name>\` in #ops-control). A private channel under a space category links itself on your first @mention.`,
  };
}
