import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { EffectsCtx } from "../orchestrator/approval/effect-context";
import { createCreatePullRequestTool } from "../tools/CreatePullRequestTool/create-pull-request-tool";
import { createDeletePathsTool } from "../tools/DeletePathsTool/delete-paths-tool";
import { createGitPushTool } from "../tools/GitPushTool/git-push-tool";
import { createMergeBranchTool } from "../tools/MergeBranchTool/merge-branch-tool";
import { EFFECTS_MCP_SERVER } from "./mcp-tool-names";

/**
 * The in-process `effects` server of ONE worker run (the context binds it to the run's goal, item and envelope, so an
 * instance is never reused). Its four tools are the only way to delete, push, open a PR or merge. New tools are added
 * here AND to `EFFECT_TOOLS`.
 */
export function createEffectsServer(ctx: EffectsCtx) {
  return createSdkMcpServer({
    name: EFFECTS_MCP_SERVER,
    tools: [
      createDeletePathsTool(ctx),
      createGitPushTool(ctx),
      createCreatePullRequestTool(ctx),
      createMergeBranchTool(ctx),
    ],
  });
}
