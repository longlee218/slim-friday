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
