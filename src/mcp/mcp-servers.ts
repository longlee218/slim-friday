import type { McpSdkServerConfigWithInstance, Options } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../observability/logger";
import { errText } from "../observability/redact";
import type { ToolMode } from "../tools/tool-catalog";
import { type GitIdentity, gitMcpServerConfig } from "./git-mcp";
import { ghToken, githubMcpServer } from "./github-mcp";
import { GIT_MCP_SERVER, GITHUB_MCP_SERVER, TASKS_MCP_SERVER } from "./mcp-tool-names";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "mcp-servers" });

/**
 * MCP servers of a mode: the git server always (the guard limits `path` and tools by mode); the READ-ONLY
 * GitHub server in code tasks (issues, PRs, code search); the in-process `tasks` server (`DelegateTask`) in Q&A.
 * PRs are created by the app, never by the agent.
 */
export async function mcpServersFor(
  mode: ToolMode,
  input: {
    githubAccount?: string;
    gitAuthor?: GitIdentity;
    gitBaseDir?: string;
    /** In-process app server (the Q&A `DelegateTask` tool); registered in Q&A only. */
    appServer?: McpSdkServerConfigWithInstance;
  },
): Promise<NonNullable<Options["mcpServers"]>> {
  const servers: NonNullable<Options["mcpServers"]> = {
    [GIT_MCP_SERVER]: gitMcpServerConfig({ author: input.gitAuthor, baseDir: input.gitBaseDir }),
  };
  if (mode === "qa" && input.appServer) servers[TASKS_MCP_SERVER] = input.appServer;
  if (mode !== "qa") {
    try {
      servers[GITHUB_MCP_SERVER] = githubMcpServer({
        token: await ghToken(input.githubAccount),
        readOnly: true,
      });
    } catch (err) {
      log.warn({ err: errText(err) }, "github mcp unavailable; continuing without it");
    }
  }
  return servers;
}
