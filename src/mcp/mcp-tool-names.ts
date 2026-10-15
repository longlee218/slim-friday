/**
 * MCP server names, MCP tool names and the helpers that make `mcp__<server>__<tool>` full names.
 * Leaf file (imports nothing): the single source of every MCP wire name used in `src/`.
 */

/** Prefix of every MCP tool name the SDK exposes. */
export const MCP_PREFIX = "mcp__";

/** `mcp__<server>__` prefix: tells which server a tool call belongs to. */
export const mcpServerPrefix = (server: string): string => `${MCP_PREFIX}${server}__`;

/** Full SDK name of an MCP tool: `mcp__<server>__<tool>`. */
export const mcpToolName = (server: string, tool: string): string =>
  `${mcpServerPrefix(server)}${tool}`;

/** Git MCP server (@cyanheads/git-mcp-server 2.15.3), started by the app. */
export const GIT_MCP_SERVER = "git";
/** Every tool of the git MCP server (names fixed by that server). */
export const GIT_TOOL = {
  STATUS: "git_status",
  DIFF: "git_diff",
  LOG: "git_log",
  SHOW: "git_show",
  BLAME: "git_blame",
  ADD: "git_add",
  COMMIT: "git_commit",
  CHECKOUT: "git_checkout",
  RESET: "git_reset",
  BRANCH: "git_branch",
  CHANGELOG_ANALYZE: "git_changelog_analyze",
  CHERRY_PICK: "git_cherry_pick",
  CLEAN: "git_clean",
  CLEAR_WORKING_DIR: "git_clear_working_dir",
  CLONE: "git_clone",
  FETCH: "git_fetch",
  INIT: "git_init",
  MERGE: "git_merge",
  PULL: "git_pull",
  PUSH: "git_push",
  REBASE: "git_rebase",
  REFLOG: "git_reflog",
  REMOTE: "git_remote",
  SET_WORKING_DIR: "git_set_working_dir",
  STASH: "git_stash",
  TAG: "git_tag",
  WORKTREE: "git_worktree",
  WRAPUP_INSTRUCTIONS: "git_wrapup_instructions",
} as const;

/** In-process memory server (SDK MCP server of the app, every role). Its tools are listed in `MEMORY_TOOLS`. */
export const MEMORY_MCP_SERVER = "memory";
/** Save a durable note (phase 5). */
export const REMEMBER_TOOL = "Remember";
/** Keyword search over saved memory (phase 6, read-only). */
export const MEMORY_SEARCH_TOOL = "MemorySearch";
/** One memory entry by id (phase 6, read-only). */
export const MEMORY_GET_TOOL = "MemoryGet";
/** The section / block / summary around an entry id (phase 6, read-only). */
export const MEMORY_EXPAND_TOOL = "MemoryExpand";
/** Name a thread and store its digest (phase 1c; registered in every role run that has a rename port; rollover/lean runs never see it). */
export const SET_THREAD_TITLE_TOOL = "SetThreadTitle";
/** Every tool of the memory server: the guard allows exactly these and denies any other `mcp__memory__*`. */
export const MEMORY_TOOLS: readonly string[] = [
  REMEMBER_TOOL,
  MEMORY_SEARCH_TOOL,
  MEMORY_GET_TOOL,
  MEMORY_EXPAND_TOOL,
  SET_THREAD_TITLE_TOOL,
];

/** In-process `discord-admin` server (the control-channel role only; added by role data `mcpServers`). */
export const DISCORD_ADMIN_MCP_SERVER = "discord-admin";
/** Read the spaces, their channels, locations and persona files (read-only). */
export const LIST_SPACES_TOOL = "ListSpaces";
/** Create a private space (category + first channel) or one more channel in a space (create-only, never deletes). */
export const CREATE_SPACE_OR_CHANNEL_TOOL = "CreateSpaceOrChannel";
/** Replace one persona / memory file of a space or channel after a diff the owner confirmed. */
export const WRITE_SPACE_FILE_TOOL = "WriteSpaceFile";
/** In-process `lead` server (the lead role only; added by role data `mcpServers`). The lead's tools are typed actions; their handlers check state, caps and CAS. */
export const LEAD_MCP_SERVER = "lead";
/** Start a goal with one worker (DIRECT) or up to three chained workers (DELEGATE). */
export const DISPATCH_AGENT_TOOL = "DispatchAgent";
/** Read the goal / item facts from the database (never from session memory). */
export const TASK_STATUS_TOOL = "TaskStatus";
/** Send owner text to a running worker (or answer its pending question). */
export const STEER_TASK_TOOL = "SteerTask";
/** Cancel a task (its dependents too) and abort its run. */
export const CANCEL_TASK_TOOL = "CancelTask";
/** Ask the owner a question with buttons; the answer comes back as the tool result. */
export const ASK_OWNER_TOOL = "AskOwner";
/** Post a finished item's result to the owner (verbatim file or excerpt). */
export const FORWARD_RESULT_TOOL = "ForwardResult";
/** Ask for one re-run of this lead input on a stronger tier. */
export const REQUEST_ESCALATION_TOOL = "RequestEscalation";
/** In-process `worker` server (every dispatched worker run; no lead tool is reachable from it). */
export const WORKER_MCP_SERVER = "worker";
/** The worker's typed end-of-run report. */
export const REPORT_RESULT_TOOL = "ReportResult";
/**
 * Tools of every app MCP server a role may list in `mcpServers` (the guard allows exactly these; any other
 * `mcp__*` tool is denied). A new in-process server = one entry here.
 */
export const APP_MCP_TOOLS: Readonly<Record<string, readonly string[]>> = {
  [DISCORD_ADMIN_MCP_SERVER]: [
    LIST_SPACES_TOOL,
    CREATE_SPACE_OR_CHANNEL_TOOL,
    WRITE_SPACE_FILE_TOOL,
  ],
  [LEAD_MCP_SERVER]: [
    DISPATCH_AGENT_TOOL,
    TASK_STATUS_TOOL,
    STEER_TASK_TOOL,
    CANCEL_TASK_TOOL,
    ASK_OWNER_TOOL,
    FORWARD_RESULT_TOOL,
    REQUEST_ESCALATION_TOOL,
  ],
  [WORKER_MCP_SERVER]: [REPORT_RESULT_TOOL],
};
