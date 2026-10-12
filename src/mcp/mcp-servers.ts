import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { type StageRef, stageOf } from "../roles/role-registry";
import { gitMcpServerConfig } from "./git-mcp";
import { GIT_MCP_SERVER } from "./mcp-tool-names";

/**
 * MCP servers of a stage, from its role DATA only: the git server (read tools) when the stage lists `gitGroups`
 * (the assistant). A stage that writes has none: its agent uses `git` and `gh` in the shell. The guard limits
 * `path` and the tools of the server.
 */
export function mcpServersFor(stage: StageRef): NonNullable<Options["mcpServers"]> {
  const servers: NonNullable<Options["mcpServers"]> = {};
  if (stageOf(stage).gitGroups.length) servers[GIT_MCP_SERVER] = gitMcpServerConfig();
  return servers;
}
