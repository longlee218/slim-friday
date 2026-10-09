import { GIT_TOOL } from "../mcp/mcp-tool-names";

/** Git MCP tools (@cyanheads/git-mcp-server 2.15.3) by purpose. Stages pick groups; the guard checks the same table. */
export const GIT_GROUPS = {
  /** Pure reads, allowed on the worktree and on registered repos. */
  read: [GIT_TOOL.STATUS, GIT_TOOL.DIFF, GIT_TOOL.LOG, GIT_TOOL.SHOW, GIT_TOOL.BLAME],
  /** Staging and committing: the task worktree only. */
  commit: [GIT_TOOL.ADD, GIT_TOOL.COMMIT],
  /** Moves HEAD / the index: the worktree only, owner is asked. */
  change: [GIT_TOOL.CHECKOUT, GIT_TOOL.RESET],
} as const;
