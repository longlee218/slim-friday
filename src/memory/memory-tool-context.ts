import type { Database } from "bun:sqlite";
import type { ThreadTitlePort } from "../ingress/thread-rename";
import type { TrustedToolIssueCode } from "../runtime/trusted-tool-issue";
import type { FlushRequest } from "./compaction-flush";
/**
 * What the tools of the in-process `memory` server need to know about the run they belong to. Built per run by
 * the role runner; the read tools (search/get/expand) read the same object.
 */
export interface MemoryToolContext {
  /** The app database: the read tools search the FTS index and the thread summaries in it. */
  db: Database;
  /** AGENT_HOME: where every memory file lives. */
  home: string;
  /** Workspace of the run: scope `channel` and `journal` resolve inside it. */
  workspace: string;
  /** Channel (yaml name) the run started in: scope `channel` writes its MEMORY.md; absent = no channel. */
  channel?: string;
  /** Discord channel id the run started in (the thread's parent): `Orchestrate set_title` stamps it on a thread row it must create. */
  channelId?: string;
  /** Thread of the run: the compaction hooks store its summary and cycle counters under it. */
  threadId?: string;
  /** Foreground run: the PostCompact hook may store the thread summary and count cycles. Background runs (developer) leave the thread summary alone. */
  trackSummary?: boolean;
  /** A foreground compaction ended (PostCompact): the app schedules the async memory flush with the new summary and the chat tail. */
  onCompacted?: (event: FlushRequest) => void;
  /** Rename port of the run's thread: its presence registers `Orchestrate set_title` (every role). Absent = no such tool. */
  threadTitle?: ThreadTitlePort;
  /** Role of the run (recorded in `memory_audit`; absent = the lead, the only memory writer). */
  role?: string;
  /** Short label of the thread: the journal block title (`## HH:MM <label>`). */
  threadLabel: string;
  /** Clock (tests pass a fixed one). One call per tool call: file date and bullet date come from the same instant. */
  now?: () => Date;
  /** A Friday-owned tool reported a known outcome (trusted code only, no text): the run supervisor counts these. */
  onIssue?: (event: { tool: string; code: TrustedToolIssueCode }) => void;
  /** Extra hook called with the path of a file a tool just changed (the memory server always re-indexes that file first). */
  onSaved?: (path: string) => void;
}
