import type { Database } from "bun:sqlite";
import { archiveTeammate, listActiveTeammates } from "../storage/teammate-store";

/**
 * Archive the teammates whose channel is in no `workspace.yaml` any more (the owner removed the channel by hand). The row
 * stays for the history. Returns the archived names so the caller can warn once at start.
 */
export function archiveOrphanTeammates(db: Database, knownChannelIds: Iterable<string>): string[] {
  const known = new Set(knownChannelIds);
  // No channel at all = the workspaces did not load (or none is set up): never archive on that.
  if (!known.size) return [];
  return listActiveTeammates(db)
    .filter((t) => !known.has(t.channelId) && archiveTeammate(db, t.id))
    .map((t) => t.name);
}
