import type { McpServerManifest } from "../manifest-types";
import { EFFECTS_MCP_SERVER } from "../mcp-tool-names";
import { CREATE_PULL_REQUEST_TOOL } from "./tools/CreatePullRequestTool/constants";
import { createCreatePullRequestTool } from "./tools/CreatePullRequestTool/create-pull-request-tool";
import { DELETE_PATHS_TOOL } from "./tools/DeletePathsTool/constants";
import { createDeletePathsTool } from "./tools/DeletePathsTool/delete-paths-tool";
import { GIT_PUSH_TOOL } from "./tools/GitPushTool/constants";
import { createGitPushTool } from "./tools/GitPushTool/git-push-tool";
import { MERGE_BRANCH_TOOL } from "./tools/MergeBranchTool/constants";
import { createMergeBranchTool } from "./tools/MergeBranchTool/merge-branch-tool";

/**
 * The `effects` server: the only way to delete, push, open a PR or merge (the ctx binds it to the run's goal, item and
 * envelope). Raw shell equivalents are denied by the guard.
 */
export const EFFECTS_SERVER: McpServerManifest = {
  name: EFFECTS_MCP_SERVER,
  tools: [
    { name: DELETE_PATHS_TOOL, create: (c) => c.effects && createDeletePathsTool(c.effects) },
    { name: GIT_PUSH_TOOL, create: (c) => c.effects && createGitPushTool(c.effects) },
    {
      name: CREATE_PULL_REQUEST_TOOL,
      create: (c) => c.effects && createCreatePullRequestTool(c.effects),
    },
    { name: MERGE_BRANCH_TOOL, create: (c) => c.effects && createMergeBranchTool(c.effects) },
  ],
};
