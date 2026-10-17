/**
 * MCP server names and the helpers that make `mcp__<server>__<tool>` full names.
 * Leaf file (imports nothing). Tool names live in each tool's own `constants.ts`
 * (`src/mcp/<server>/tools/<Name>Tool/constants.ts`).
 */

/** Prefix of every MCP tool name the SDK exposes. */
export const MCP_PREFIX = "mcp__";

/** `mcp__<server>__` prefix: tells which server a tool call belongs to. */
export const mcpServerPrefix = (server: string): string => `${MCP_PREFIX}${server}__`;

/** Full SDK name of an MCP tool: `mcp__<server>__<tool>`. */
export const mcpToolName = (server: string, tool: string): string =>
  `${mcpServerPrefix(server)}${tool}`;

/** Memory server: save, search, read and expand notes. */
export const MEMORY_MCP_SERVER = "memory";
/** Orchestration server: the lead's typed actions, `SetThreadTitle` and the worker's `ReportResult` (isolated per run by `role.mcpTools`). */
export const ORCHESTRATION_MCP_SERVER = "orchestration";
/** Plan server: the planner's read tools and plan-row writers. */
export const PLAN_MCP_SERVER = "plan";
/** Effects server: the only way to delete, push, open a PR or merge. */
export const EFFECTS_MCP_SERVER = "effects";
/** Discord admin server: the control-channel role's space tools. */
export const DISCORD_ADMIN_MCP_SERVER = "discord-admin";

/** Firecrawl server (external, hosted): its tool names live in `src/mcp/firecrawl/tools/<Name>Tool/constants.ts`. */
export const FIRECRAWL_MCP_SERVER = "firecrawl";
