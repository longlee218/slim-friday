import type { McpServerManifest } from "../manifest-types";
import { ORCHESTRATION_MCP_SERVER } from "../mcp-tool-names";
import { createApprovePlanTool } from "./tools/ApprovePlanTool/approve-plan-tool";
import { APPROVE_PLAN_TOOL } from "./tools/ApprovePlanTool/constants";
import { createAskOwnerTool } from "./tools/AskOwnerTool/ask-owner-tool";
import { ASK_OWNER_TOOL } from "./tools/AskOwnerTool/constants";
import { createCancelTaskTool } from "./tools/CancelTaskTool/cancel-task-tool";
import { CANCEL_TASK_TOOL } from "./tools/CancelTaskTool/constants";
import { DISPATCH_AGENT_TOOL } from "./tools/DispatchAgentTool/constants";
import { createDispatchAgentTool } from "./tools/DispatchAgentTool/dispatch-agent-tool";
import { FORWARD_RESULT_TOOL } from "./tools/ForwardResultTool/constants";
import { createForwardResultTool } from "./tools/ForwardResultTool/forward-result-tool";
import { REGISTER_LOCATION_TOOL } from "./tools/RegisterLocationTool/constants";
import { createRegisterLocationTool } from "./tools/RegisterLocationTool/register-location-tool";
import { REPORT_PROGRESS_TOOL } from "./tools/ReportProgressTool/constants";
import { createReportProgressTool } from "./tools/ReportProgressTool/report-progress-tool";
import { REPORT_RESULT_TOOL } from "./tools/ReportResultTool/constants";
import { createReportResultTool } from "./tools/ReportResultTool/report-result-tool";
import { REQUEST_PLAN_TOOL } from "./tools/RequestPlanTool/constants";
import { createRequestPlanTool } from "./tools/RequestPlanTool/request-plan-tool";
import { RETRY_TASK_TOOL } from "./tools/RetryTaskTool/constants";
import { createRetryTaskTool } from "./tools/RetryTaskTool/retry-task-tool";
import { SET_THREAD_TITLE_TOOL } from "./tools/SetThreadTitleTool/constants";
import { createSetThreadTitleTool } from "./tools/SetThreadTitleTool/set-thread-title-tool";
import { STEER_TASK_TOOL } from "./tools/SteerTaskTool/constants";
import { createSteerTaskTool } from "./tools/SteerTaskTool/steer-task-tool";
import { TASK_STATUS_TOOL } from "./tools/TaskStatusTool/constants";
import { createTaskStatusTool } from "./tools/TaskStatusTool/task-status-tool";

/**
 * The `orchestration` server: the lead's typed actions, `SetThreadTitle` (a run with a rename port) and the
 * worker's `ReportResult` and `ReportProgress`. One server, isolated per run: an instance holds only the tools
 * of `role.mcpTools` whose ctx part the run has, so a worker (no `lead` part) never holds a lead tool.
 */
export const ORCHESTRATION_SERVER: McpServerManifest = {
  name: ORCHESTRATION_MCP_SERVER,
  tools: [
    { name: DISPATCH_AGENT_TOOL, create: (c) => c.lead && createDispatchAgentTool(c.lead) },
    { name: TASK_STATUS_TOOL, create: (c) => c.lead && createTaskStatusTool(c.lead) },
    { name: STEER_TASK_TOOL, create: (c) => c.lead && createSteerTaskTool(c.lead) },
    { name: CANCEL_TASK_TOOL, create: (c) => c.lead && createCancelTaskTool(c.lead) },
    { name: RETRY_TASK_TOOL, create: (c) => c.lead && createRetryTaskTool(c.lead) },
    { name: ASK_OWNER_TOOL, create: (c) => c.lead && createAskOwnerTool(c.lead) },
    { name: REGISTER_LOCATION_TOOL, create: (c) => c.lead && createRegisterLocationTool(c.lead) },
    { name: FORWARD_RESULT_TOOL, create: (c) => c.lead && createForwardResultTool(c.lead) },
    { name: REQUEST_PLAN_TOOL, create: (c) => c.lead && createRequestPlanTool(c.lead) },
    { name: APPROVE_PLAN_TOOL, create: (c) => c.lead && createApprovePlanTool(c.lead) },
    {
      name: SET_THREAD_TITLE_TOOL,
      // Only a run with a rename port (lean/rollover runs build none, so they never see it).
      create: (c) => c.memory?.threadTitle && createSetThreadTitleTool(c.memory),
    },
    {
      name: REPORT_PROGRESS_TOOL,
      create: (c) => c.progress && createReportProgressTool(c.progress),
    },
    {
      name: REPORT_RESULT_TOOL,
      create: (c) => c.reportSink && createReportResultTool(c.reportSink),
    },
  ],
};
