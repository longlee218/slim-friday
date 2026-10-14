import type { Database } from "bun:sqlite";
import type { MemoryToolContext } from "../tools/memory-tool-context";
import { loadWorkspaces } from "../workspaces/workspace-registry";

/**
 * The memory context of one run (tools + compaction hooks): one builder for the role runner and the rollover runs.
 * Location names are read from the workspace registry only when a tool needs them. `location` = the run's single location.
 */
export function buildMemoryToolContext(p: {
  db: Database;
  home: string;
  workspace: string;
  threadId: string;
  /** Foreground run: the PostCompact hook may store the thread summary. */
  trackSummary: boolean;
  location?: string;
  /** A Friday-owned tool reported a known outcome (the run supervisor counts these). */
  onIssue?: MemoryToolContext["onIssue"];
}): MemoryToolContext {
  return {
    db: p.db,
    home: p.home,
    workspace: p.workspace,
    locationNames: () =>
      (loadWorkspaces(p.home).workspaces.find((w) => w.name === p.workspace)?.locations ?? []).map(
        (r) => r.name,
      ),
    location: p.location,
    threadId: p.threadId,
    trackSummary: p.trackSummary,
    threadLabel: `thread ${p.threadId.slice(-6)}`,
    ...(p.onIssue && { onIssue: p.onIssue }),
  };
}
