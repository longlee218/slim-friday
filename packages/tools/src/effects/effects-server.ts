import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { EFFECTS_MCP_SERVER } from "../mcp-server-names";
import type { EffectsContext } from "./effects-context";
import { createCreateProjectTool } from "./tools/CreateProjectTool/create-project-tool";
import { createCreatePullRequestTool } from "./tools/CreatePullRequestTool/create-pull-request-tool";
import { createDeletePathsTool } from "./tools/DeletePathsTool/delete-paths-tool";
import { createGitPushTool } from "./tools/GitPushTool/git-push-tool";
import { createMergeBranchTool } from "./tools/MergeBranchTool/merge-branch-tool";

/**
 * The effect tools a bot names in its `tools`: `mcp__effects` = all of them, `mcp__effects__<Name>` = that one.
 * A tool the bot does not name is not built, so it cannot be called.
 */
export function effectsTools(ctx: EffectsContext, projectsDir: string, botTools: string[]) {
  const prefix = `mcp__${EFFECTS_MCP_SERVER}`;
  const all = [
    createDeletePathsTool(ctx),
    createGitPushTool(ctx),
    createCreatePullRequestTool(ctx),
    createMergeBranchTool(ctx),
    createCreateProjectTool(ctx, projectsDir),
  ];
  if (botTools.includes(prefix)) return all;
  return all.filter((t) => botTools.includes(`${prefix}__${t.name}`));
}

/** The `effects` server of one session with only the tools the bot names (built per session, never shared). */
export function effectsServer(ctx: EffectsContext, projectsDir: string, botTools: string[]) {
  return createSdkMcpServer({
    name: EFFECTS_MCP_SERVER,
    tools: effectsTools(ctx, projectsDir, botTools),
  });
}
