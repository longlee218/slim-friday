import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { LeadToolContext } from "../orchestrator/engine/lead-call";
import { createApprovePlanTool } from "../tools/ApprovePlanTool/approve-plan-tool";
import { createAskOwnerTool } from "../tools/AskOwnerTool/ask-owner-tool";
import { createCancelTaskTool } from "../tools/CancelTaskTool/cancel-task-tool";
import { createDispatchAgentTool } from "../tools/DispatchAgentTool/dispatch-agent-tool";
import { createForwardResultTool } from "../tools/ForwardResultTool/forward-result-tool";
import { createRequestPlanTool } from "../tools/RequestPlanTool/request-plan-tool";
import { createSteerTaskTool } from "../tools/SteerTaskTool/steer-task-tool";
import { createTaskStatusTool } from "../tools/TaskStatusTool/task-status-tool";
import { LEAD_MCP_SERVER } from "./mcp-tool-names";

/**
 * The in-process `lead` server of ONE lead run (SDK MCP server in the app process; the context carries the run's
 * port and counters, so an instance is never reused across runs). New tools are added here AND to `APP_MCP_TOOLS`.
 */
export function createLeadServer(ctx: LeadToolContext) {
  return createSdkMcpServer({
    name: LEAD_MCP_SERVER,
    tools: [
      createDispatchAgentTool(ctx),
      createTaskStatusTool(ctx),
      createSteerTaskTool(ctx),
      createCancelTaskTool(ctx),
      createAskOwnerTool(ctx),
      createForwardResultTool(ctx),
      createRequestPlanTool(ctx),
      createApprovePlanTool(ctx),
    ],
  });
}
