import type { Database } from "bun:sqlite";
/**
 * What the tools of the in-process `memory` server need to know about the run they belong to. Built per run by
 * the role runner; the read tools (search/get/expand) read the same object.
 */
export interface MemoryToolContext {
  /** The app database: the read tools search the FTS index and the thread summaries in it. */
  db: Database;
  /** AGENT_HOME: where every memory file lives. */
  home: string;
  /** Workspace of the run: scope `workspace`, `repo` and `journal` resolve inside it. */
  workspace: string;
  /** Valid repo names of the workspace (the registry), read when a tool needs them. */
  repoNames: () => string[];
  /** The run's single repo, when it has exactly one: stamps `global` notes with their origin (`[ws/repo]`). */
  repo?: string;
  /** Thread of the run: the compaction hooks store its summary and cycle counters under it. */
  threadId?: string;
  /** Foreground run: the PostCompact hook may store the thread summary and count cycles. Background runs (dev) leave the thread summary alone. */
  trackSummary?: boolean;
  /**
   * The app's own rollover `/compact` (phase 9): PostCompact saves the SDK summary AS IS (no merge, no cycle bump:
   * `markRolled` counts it), hands it to `onSummary`, and PreCompact skips its extract (the LLM flush already ran).
   */
  rollover?: { onSummary: (summary: string) => void };
  /** Short label of the thread: the journal block title (`## HH:MM <label>`). */
  threadLabel: string;
  /** Clock (tests pass a fixed one). One call per tool call: file date and bullet date come from the same instant. */
  now?: () => Date;
  /** Extra hook called with the path of a file a tool just changed (the memory server always re-indexes that file first). */
  onSaved?: (path: string) => void;
}
