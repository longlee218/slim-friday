import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { EFFECTS_MCP_SERVER } from "../mcp-server-names";
import type { EffectsContext } from "./effects-context";
import { createCreateProjectTool } from "./tools/CreateProjectTool/create-project-tool";
import { createCreatePullRequestTool } from "./tools/CreatePullRequestTool/create-pull-request-tool";
import { createDeletePathsTool } from "./tools/DeletePathsTool/delete-paths-tool";
import { createGitPushTool } from "./tools/GitPushTool/git-push-tool";
import { createMergeBranchTool } from "./tools/MergeBranchTool/merge-branch-tool";

/** The `effects` server of one session (built per session, never shared); projects go under `projectsDir`. */
export function effectsServer(ctx: EffectsContext, projectsDir: string) {
  return createSdkMcpServer({
    name: EFFECTS_MCP_SERVER,
    tools: [
      createDeletePathsTool(ctx),
      createGitPushTool(ctx),
      createCreatePullRequestTool(ctx),
      createMergeBranchTool(ctx),
      createCreateProjectTool(ctx, projectsDir),
    ],
  });
}
