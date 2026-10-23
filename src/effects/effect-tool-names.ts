import { CREATE_PULL_REQUEST_TOOL } from "../mcp/effects/tools/CreatePullRequestTool/constants";
import { DELETE_PATHS_TOOL } from "../mcp/effects/tools/DeletePathsTool/constants";
import { GIT_PUSH_TOOL } from "../mcp/effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "../mcp/effects/tools/MergeBranchTool/constants";

/** The effect tools: each one is checked against the run's envelope (leaf file: names only, no tool code). */
export const EFFECT_TOOL_NAMES = [
  DELETE_PATHS_TOOL,
  GIT_PUSH_TOOL,
  CREATE_PULL_REQUEST_TOOL,
  MERGE_BRANCH_TOOL,
] as const;
