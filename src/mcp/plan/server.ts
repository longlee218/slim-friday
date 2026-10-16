import type { McpServerManifest } from "../manifest-types";
import { PLAN_MCP_SERVER } from "../mcp-tool-names";
import { createAnalyzeBlockersTool } from "./tools/AnalyzeBlockersTool/analyze-blockers-tool";
import { ANALYZE_BLOCKERS_TOOL } from "./tools/AnalyzeBlockersTool/constants";
import { CREATE_PLAN_TOOL } from "./tools/CreatePlanTool/constants";
import { createCreatePlanTool } from "./tools/CreatePlanTool/create-plan-tool";
import { GET_AGENT_CAPABILITIES_TOOL } from "./tools/GetAgentCapabilitiesTool/constants";
import { createGetAgentCapabilitiesTool } from "./tools/GetAgentCapabilitiesTool/get-agent-capabilities-tool";
import { GET_EXECUTION_PROGRESS_TOOL } from "./tools/GetExecutionProgressTool/constants";
import { createGetExecutionProgressTool } from "./tools/GetExecutionProgressTool/get-execution-progress-tool";
import { GET_PROJECT_CONTEXT_TOOL } from "./tools/GetProjectContextTool/constants";
import { createGetProjectContextTool } from "./tools/GetProjectContextTool/get-project-context-tool";
import { PROPOSE_PLAN_REVISION_TOOL } from "./tools/ProposePlanRevisionTool/constants";
import { createProposePlanRevisionTool } from "./tools/ProposePlanRevisionTool/propose-plan-revision-tool";
import { VALIDATE_PLAN_TOOL } from "./tools/ValidatePlanTool/constants";
import { createValidatePlanTool } from "./tools/ValidatePlanTool/validate-plan-tool";

/**
 * The `plan` server: the planner reads the project and writes plan rows only (the ctx binds the run to its goal).
 * It holds no lead tool and no effect tool.
 */
export const PLAN_SERVER: McpServerManifest = {
  name: PLAN_MCP_SERVER,
  tools: [
    {
      name: GET_PROJECT_CONTEXT_TOOL,
      create: (c) => c.plan && createGetProjectContextTool(c.plan),
    },
    {
      name: GET_AGENT_CAPABILITIES_TOOL,
      create: (c) => c.plan && createGetAgentCapabilitiesTool(c.plan),
    },
    { name: CREATE_PLAN_TOOL, create: (c) => c.plan && createCreatePlanTool(c.plan) },
    { name: VALIDATE_PLAN_TOOL, create: (c) => c.plan && createValidatePlanTool(c.plan) },
    {
      name: PROPOSE_PLAN_REVISION_TOOL,
      create: (c) => c.plan && createProposePlanRevisionTool(c.plan),
    },
    {
      name: GET_EXECUTION_PROGRESS_TOOL,
      create: (c) => c.plan && createGetExecutionProgressTool(c.plan),
    },
    { name: ANALYZE_BLOCKERS_TOOL, create: (c) => c.plan && createAnalyzeBlockersTool(c.plan) },
  ],
};
