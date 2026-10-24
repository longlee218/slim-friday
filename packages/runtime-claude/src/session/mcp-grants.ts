import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/** Prefix of MCP tool names: `mcp__<server>__<tool>`. */
const MCP = "mcp__";

/** Server and tool of an MCP name (`mcp__s` = the whole server, `mcp__s__t` = one tool). */
function parse(name: string): { server: string; tool?: string } | undefined {
  if (!name.startsWith(MCP)) return undefined;
  const [server, ...rest] = name.slice(MCP.length).split("__");
  return server ? { server, ...(rest.length && { tool: rest.join("__") }) } : undefined;
}

/** The bot's tool names split into SDK built-ins and MCP names. */
export function splitTools(names: string[]): { builtIn: string[]; mcp: string[] } {
  return {
    builtIn: names.filter((n) => !n.startsWith(MCP)),
    mcp: names.filter((n) => n.startsWith(MCP)),
  };
}

/**
 * The MCP servers of one session: the configured (external) servers the bot names, plus every per-session server
 * the app built for it. A named server that is not configured is skipped.
 */
export function pickServers(
  mcpNames: string[],
  configured: Record<string, McpServerConfig>,
  perSession: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const named = new Set(mcpNames.flatMap((n) => parse(n)?.server ?? []));
  const picked = Object.fromEntries(Object.entries(configured).filter(([s]) => named.has(s)));
  return { ...picked, ...perSession };
}

/**
 * True when an MCP tool call is granted: the bot names its whole server or that tool, or the server is one the app
 * built for this session. A non-MCP name is not this check's business (true).
 */
export function mcpGranted(tool: string, mcpNames: string[], perSession: string[]): boolean {
  const call = parse(tool);
  if (!call) return true;
  if (perSession.includes(call.server)) return true;
  return mcpNames.some((n) => {
    const g = parse(n);
    return g?.server === call.server && (g.tool === undefined || g.tool === call.tool);
  });
}
