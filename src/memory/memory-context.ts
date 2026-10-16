import type { Database } from "bun:sqlite";
import type { ThreadTitlePort } from "../ingress/thread-rename";
import { loadWorkspaces } from "../workspaces/workspace-registry";
import type { MemoryToolContext } from "./memory-tool-context";

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
  /** Channel (yaml name) of the run. */
  channel?: string;
  /** Discord channel id of the run (the thread's parent); stamped on a thread row created by `SetThreadTitle`. */
  channelId?: string;
  /** Location names the run may use (the channel's subset); absent = every location of the space (rollover runs). */
  locationNames?: string[];
  /** Rename port (every role with a port; not rollover runs): registers `SetThreadTitle`. */
  threadTitle?: ThreadTitlePort;
  /** A Friday-owned tool reported a known outcome (the run supervisor counts these). */
  onIssue?: MemoryToolContext["onIssue"];
}): MemoryToolContext {
  return {
    db: p.db,
    home: p.home,
    workspace: p.workspace,
    locationNames: () =>
      p.locationNames ??
      (loadWorkspaces(p.home).workspaces.find((w) => w.name === p.workspace)?.locations ?? []).map(
        (r) => r.name,
      ),
    location: p.location,
    channel: p.channel,
    channelId: p.channelId,
    threadId: p.threadId,
    trackSummary: p.trackSummary,
    threadTitle: p.threadTitle,
    threadLabel: `thread ${p.threadId.slice(-6)}`,
    ...(p.onIssue && { onIssue: p.onIssue }),
  };
}
