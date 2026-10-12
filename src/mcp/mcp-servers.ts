import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { RoleDefinition } from "../roles/role-types";
import { gitMcpServerConfig } from "./git-mcp";
import { GIT_MCP_SERVER } from "./mcp-tool-names";

/**
 * MCP servers of a role, from its role DATA only: the git server (read tools) when the role lists `gitGroups`
 * (the assistant). A role that writes has none: its agent uses `git` and `gh` in the shell. The guard limits
 * `path` and the tools of the server.
 */
export function mcpServersFor(role: RoleDefinition): NonNullable<Options["mcpServers"]> {
  const servers: NonNullable<Options["mcpServers"]> = {};
  if (role.gitGroups.length) servers[GIT_MCP_SERVER] = gitMcpServerConfig();
  return servers;
}
