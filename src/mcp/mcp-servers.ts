import type { McpSdkServerConfigWithInstance, Options } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { type StageRef, stageOf } from "../roles/role-registry";
import { type GitIdentity, gitMcpServerConfig } from "./git-mcp";
import { ghToken, githubMcpServer } from "./github-mcp";
import { GIT_MCP_SERVER, GITHUB_MCP_SERVER, TASKS_MCP_SERVER } from "./mcp-tool-names";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "mcp-servers" });

/**
 * MCP servers of a stage: the git server when it has git groups (the guard limits `path` and tools by stage);
 * the READ-ONLY GitHub server for stages that write (code tasks: issues, PRs, code search); the in-process
 * `tasks` server (`DelegateTask`) for stages with the `recommend` capability. PRs are created by the app.
 */
export async function mcpServersFor(
  stage: StageRef,
  input: {
    githubAccount?: string;
    gitAuthor?: GitIdentity;
    gitBaseDir?: string;
    /** In-process app server (the `DelegateTask` tool); registered for stages with `recommend` only. */
    appServer?: McpSdkServerConfigWithInstance;
  },
): Promise<NonNullable<Options["mcpServers"]>> {
  const s = stageOf(stage);
  const servers: NonNullable<Options["mcpServers"]> = {};
  if (s.gitGroups.length) {
    servers[GIT_MCP_SERVER] = gitMcpServerConfig({
      author: input.gitAuthor,
      baseDir: input.gitBaseDir,
    });
  }
  if (s.capabilities.includes("recommend") && input.appServer) {
    servers[TASKS_MCP_SERVER] = input.appServer;
  }
  if (s.capabilities.includes("write")) {
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
