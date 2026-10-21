import type { Database } from "bun:sqlite";
import type { ThreadTitlePort } from "../ingress/thread-rename";
import type { MemoryToolContext } from "./memory-tool-context";

/**
 * The memory context of one run (tools + compaction hooks): one builder for the role runner.
 */
export function buildMemoryToolContext(p: {
  db: Database;
  home: string;
  workspace: string;
  threadId: string;
  /** Foreground run: the PostCompact hook may store the thread summary. */
  trackSummary: boolean;
  /** Channel (yaml name) of the run. */
  channel?: string;
  /** Discord channel id of the run (the thread's parent); stamped on a thread row created by `Orchestrate set_title`. */
  channelId?: string;
  /** Rename port (every role with a port): registers `Orchestrate set_title`. */
  threadTitle?: ThreadTitlePort;
  /** A Friday-owned tool reported a known outcome (the run supervisor counts these). */
  onIssue?: MemoryToolContext["onIssue"];
  /** The async memory flush after a compaction (foreground runs). */
  onCompacted?: MemoryToolContext["onCompacted"];
}): MemoryToolContext {
  return {
    db: p.db,
    home: p.home,
    workspace: p.workspace,
    channel: p.channel,
    channelId: p.channelId,
    threadId: p.threadId,
    trackSummary: p.trackSummary,
    threadTitle: p.threadTitle,
    threadLabel: `thread ${p.threadId.slice(-6)}`,
    ...(p.onIssue && { onIssue: p.onIssue }),
    ...(p.onCompacted && { onCompacted: p.onCompacted }),
  };
}
