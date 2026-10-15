import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { PlannerCtx } from "../orchestrator/plan/planner-handlers";
import { createAnalyzeBlockersTool } from "../tools/AnalyzeBlockersTool/analyze-blockers-tool";
import { createCreatePlanTool } from "../tools/CreatePlanTool/create-plan-tool";
import { createGetAgentCapabilitiesTool } from "../tools/GetAgentCapabilitiesTool/get-agent-capabilities-tool";
import { createGetExecutionProgressTool } from "../tools/GetExecutionProgressTool/get-execution-progress-tool";
import { createGetProjectContextTool } from "../tools/GetProjectContextTool/get-project-context-tool";
import { createProposePlanRevisionTool } from "../tools/ProposePlanRevisionTool/propose-plan-revision-tool";
import { createValidatePlanTool } from "../tools/ValidatePlanTool/validate-plan-tool";
import { PLANNER_MCP_SERVER } from "./mcp-tool-names";

/**
 * The in-process `planner` server of ONE planner run (the context binds the run to its goal, so an instance is never
 * reused). It holds no lead tool and no effect tool: the planner reads the project and writes plan rows only.
 * New tools are added here AND to `APP_MCP_TOOLS`.
 */
export function createPlannerServer(ctx: PlannerCtx) {
  return createSdkMcpServer({
    name: PLANNER_MCP_SERVER,
    tools: [
      createGetProjectContextTool(ctx),
      createGetAgentCapabilitiesTool(ctx),
      createCreatePlanTool(ctx),
      createValidatePlanTool(ctx),
      createProposePlanRevisionTool(ctx),
      createGetExecutionProgressTool(ctx),
      createAnalyzeBlockersTool(ctx),
    ],
  });
}
