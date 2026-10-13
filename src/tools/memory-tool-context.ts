/**
 * What the tools of the in-process `memory` server need to know about the run they belong to. Built per run by
 * the role runner; phase 6 tools (search/get/expand) read the same object (they add `db` here).
 */
export interface MemoryToolContext {
  /** AGENT_HOME: where every memory file lives. */
  home: string;
  /** Workspace of the run: scope `workspace`, `repo` and `journal` resolve inside it. */
  workspace: string;
  /** Valid repo names of the workspace (the registry), read when a tool needs them. */
  repoNames: () => string[];
  /** The run's single repo, when it has exactly one: stamps `global` notes with their origin (`[ws/repo]`). */
  repo?: string;
  /** Short label of the thread: the journal block title (`## HH:MM <label>`). */
  threadLabel: string;
  /** Clock (tests pass a fixed one). One call per tool call: file date and bullet date come from the same instant. */
  now?: () => Date;
  /** Hook point: called with the path of a file a tool just changed (phase 6 wires the FTS index here). */
  onSaved?: (path: string) => void;
}
