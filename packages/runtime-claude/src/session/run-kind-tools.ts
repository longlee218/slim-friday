import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/**
 * The only tools of an intro run (the first hidden run of a new bot). `mcp__chat__UpdateProfile` is created later;
 * a name with no registered tool is harmless: only the tool list and the grant check read it.
 */
export const INTRO_TOOLS = ["AskUserQuestion", "mcp__chat__UpdateProfile"];

/**
 * The per-session MCP servers of a run: all of them, except for an intro run, which keeps only the servers its
 * fixed tool list names (`mcp__<server>__<tool>`).
 */
export function introServers(
  intro: boolean,
  perSession: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  if (!intro) return perSession;
  return Object.fromEntries(
    Object.entries(perSession).filter(([s]) =>
      INTRO_TOOLS.some((t) => t.startsWith(`mcp__${s}__`)),
    ),
  );
}
