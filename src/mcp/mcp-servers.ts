import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { RoleDefinition } from "../roles/role-types";
import type { MemoryToolContext } from "../tools/memory-tool-context";
import { gitMcpServerConfig } from "./git-mcp";
import { GIT_MCP_SERVER, MEMORY_MCP_SERVER } from "./mcp-tool-names";
import { createMemoryServer } from "./memory-server";

/**
 * MCP servers of a role, from its role DATA only: the git server (read tools) when the role lists `gitGroups`
 * (the assistant). A role that writes has none: its agent uses `git` and `gh` in the shell. The guard limits
 * `path` and the tools of the server. The in-process `memory` server is added to EVERY role when the run
 * brings a `memory` context (a run without one, e.g. a classifier call, has no memory tools).
 */
export function mcpServersFor(
  role: RoleDefinition,
  memory?: MemoryToolContext,
): NonNullable<Options["mcpServers"]> {
  const servers: NonNullable<Options["mcpServers"]> = {};
  if (role.gitGroups.length) servers[GIT_MCP_SERVER] = gitMcpServerConfig();
  if (memory) servers[MEMORY_MCP_SERVER] = createMemoryServer(memory);
  return servers;
}
