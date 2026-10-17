import type { RoleDefinition } from "../roles/role-types";
import { CREATE_SPACE_OR_CHANNEL_TOOL } from "./discord-admin/tools/CreateSpaceOrChannelTool/constants";
import { LIST_SPACES_TOOL } from "./discord-admin/tools/ListSpacesTool/constants";
import { WRITE_SPACE_FILE_TOOL } from "./discord-admin/tools/WriteSpaceFileTool/constants";
import { CREATE_PULL_REQUEST_TOOL } from "./effects/tools/CreatePullRequestTool/constants";
import { DELETE_PATHS_TOOL } from "./effects/tools/DeletePathsTool/constants";
import { GIT_PUSH_TOOL } from "./effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "./effects/tools/MergeBranchTool/constants";
import {
  DISCORD_ADMIN_MCP_SERVER,
  EFFECTS_MCP_SERVER,
  MEMORY_MCP_SERVER,
  mcpToolName,
  ORCHESTRATION_MCP_SERVER,
  PLAN_MCP_SERVER,
} from "./mcp-tool-names";
import { MEMORY_EXPAND_TOOL } from "./memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "./memory/tools/MemoryGetTool/constants";
import { MEMORY_SAVE_TOOL } from "./memory/tools/MemorySaveTool/constants";
import { MEMORY_SEARCH_TOOL } from "./memory/tools/MemorySearchTool/constants";
import { APPROVE_PLAN_TOOL } from "./orchestration/tools/ApprovePlanTool/constants";
import { ASK_OWNER_TOOL } from "./orchestration/tools/AskOwnerTool/constants";
import { CANCEL_TASK_TOOL } from "./orchestration/tools/CancelTaskTool/constants";
import { DISPATCH_AGENT_TOOL } from "./orchestration/tools/DispatchAgentTool/constants";
import { FORWARD_RESULT_TOOL } from "./orchestration/tools/ForwardResultTool/constants";
import { REPORT_PROGRESS_TOOL } from "./orchestration/tools/ReportProgressTool/constants";
import { REPORT_RESULT_TOOL } from "./orchestration/tools/ReportResultTool/constants";
import { REQUEST_PLAN_TOOL } from "./orchestration/tools/RequestPlanTool/constants";
import { SET_THREAD_TITLE_TOOL } from "./orchestration/tools/SetThreadTitleTool/constants";
import { STEER_TASK_TOOL } from "./orchestration/tools/SteerTaskTool/constants";
import { TASK_STATUS_TOOL } from "./orchestration/tools/TaskStatusTool/constants";
import { ANALYZE_BLOCKERS_TOOL } from "./plan/tools/AnalyzeBlockersTool/constants";
import { CREATE_PLAN_TOOL } from "./plan/tools/CreatePlanTool/constants";
import { GET_AGENT_CAPABILITIES_TOOL } from "./plan/tools/GetAgentCapabilitiesTool/constants";
import { GET_EXECUTION_PROGRESS_TOOL } from "./plan/tools/GetExecutionProgressTool/constants";
import { GET_PROJECT_CONTEXT_TOOL } from "./plan/tools/GetProjectContextTool/constants";
import { PROPOSE_PLAN_REVISION_TOOL } from "./plan/tools/ProposePlanRevisionTool/constants";
import { VALIDATE_PLAN_TOOL } from "./plan/tools/ValidatePlanTool/constants";

/**
 * Server of every MCP tool, by bare tool name. Leaf data (imports only `constants.ts` files and server names, never
 * tool code), so the guard can list a role's MCP tools without loading the tool graph. A test checks that it matches
 * the server manifests exactly.
 */
export const MCP_TOOL_SERVER: Readonly<Record<string, string>> = {
  [CREATE_SPACE_OR_CHANNEL_TOOL]: DISCORD_ADMIN_MCP_SERVER,
  [LIST_SPACES_TOOL]: DISCORD_ADMIN_MCP_SERVER,
  [WRITE_SPACE_FILE_TOOL]: DISCORD_ADMIN_MCP_SERVER,
  [CREATE_PULL_REQUEST_TOOL]: EFFECTS_MCP_SERVER,
  [DELETE_PATHS_TOOL]: EFFECTS_MCP_SERVER,
  [GIT_PUSH_TOOL]: EFFECTS_MCP_SERVER,
  [MERGE_BRANCH_TOOL]: EFFECTS_MCP_SERVER,
  [MEMORY_EXPAND_TOOL]: MEMORY_MCP_SERVER,
  [MEMORY_GET_TOOL]: MEMORY_MCP_SERVER,
  [MEMORY_SAVE_TOOL]: MEMORY_MCP_SERVER,
  [MEMORY_SEARCH_TOOL]: MEMORY_MCP_SERVER,
  [APPROVE_PLAN_TOOL]: ORCHESTRATION_MCP_SERVER,
  [ASK_OWNER_TOOL]: ORCHESTRATION_MCP_SERVER,
  [CANCEL_TASK_TOOL]: ORCHESTRATION_MCP_SERVER,
  [DISPATCH_AGENT_TOOL]: ORCHESTRATION_MCP_SERVER,
  [FORWARD_RESULT_TOOL]: ORCHESTRATION_MCP_SERVER,
  [REPORT_PROGRESS_TOOL]: ORCHESTRATION_MCP_SERVER,
  [REPORT_RESULT_TOOL]: ORCHESTRATION_MCP_SERVER,
  [REQUEST_PLAN_TOOL]: ORCHESTRATION_MCP_SERVER,
  [SET_THREAD_TITLE_TOOL]: ORCHESTRATION_MCP_SERVER,
  [STEER_TASK_TOOL]: ORCHESTRATION_MCP_SERVER,
  [TASK_STATUS_TOOL]: ORCHESTRATION_MCP_SERVER,
  [ANALYZE_BLOCKERS_TOOL]: PLAN_MCP_SERVER,
  [CREATE_PLAN_TOOL]: PLAN_MCP_SERVER,
  [GET_AGENT_CAPABILITIES_TOOL]: PLAN_MCP_SERVER,
  [GET_EXECUTION_PROGRESS_TOOL]: PLAN_MCP_SERVER,
  [GET_PROJECT_CONTEXT_TOOL]: PLAN_MCP_SERVER,
  [PROPOSE_PLAN_REVISION_TOOL]: PLAN_MCP_SERVER,
  [VALIDATE_PLAN_TOOL]: PLAN_MCP_SERVER,
};

/** Full names (`mcp__<server>__<tool>`) of the MCP tools of a role (the guard allows exactly these). */
export const mcpToolNamesOfRole = (role: RoleDefinition): string[] =>
  (role.mcpTools ?? []).flatMap((t) => {
    const server = MCP_TOOL_SERVER[t];
    return server ? [mcpToolName(server, t)] : [];
  });
