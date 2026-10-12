import { GIT_TOOL } from "../mcp/mcp-tool-names";

/**
 * Git MCP tools (@cyanheads/git-mcp-server 2.15.3) a stage may use. Only reads: the dev agent changes git through
 * its shell, so no stage gets the staging/commit/checkout tools. A role lists groups in its `gitGroups` data.
 */
export const GIT_GROUPS = {
  /** Pure reads, allowed on registered repos. */
  read: [GIT_TOOL.STATUS, GIT_TOOL.DIFF, GIT_TOOL.LOG, GIT_TOOL.SHOW, GIT_TOOL.BLAME],
} as const;
