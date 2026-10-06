import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../observability/logger";
import { errText } from "../observability/redact";
import type { ToolMode } from "../tools/tool-catalog";
import { type GitIdentity, gitMcpServerConfig } from "./git-mcp";
import { ghToken, githubMcpServer } from "./github-mcp";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "mcp-servers" });

/**
 * MCP servers of a mode: the git server always (the guard limits `path` and tools by mode); the READ-ONLY
 * GitHub server in code tasks (issues, PRs, code search). PRs are created by the app, never by the agent.
 */
export async function mcpServersFor(
  mode: ToolMode,
  input: { githubAccount?: string; gitAuthor?: GitIdentity; gitBaseDir?: string },
): Promise<NonNullable<Options["mcpServers"]>> {
  const servers: NonNullable<Options["mcpServers"]> = {
    git: gitMcpServerConfig({ author: input.gitAuthor, baseDir: input.gitBaseDir }),
  };
  if (mode !== "qa") {
    try {
      servers.github = githubMcpServer({
        token: await ghToken(input.githubAccount),
        readOnly: true,
      });
    } catch (err) {
      log.warn({ err: errText(err) }, "github mcp unavailable; continuing without it");
    }
  }
  return servers;
}
