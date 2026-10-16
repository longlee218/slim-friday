import { Database } from "bun:sqlite";
import type { RunCtx } from "../src/mcp/manifest-types";
import { ALL_SERVERS } from "../src/mcp/manifests";
import { buildServers } from "../src/mcp/mcp-servers";
import { MEMORY_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { APPROVE_PLAN_TOOL } from "../src/mcp/orchestration/tools/ApprovePlanTool/constants";
import { ASK_OWNER_TOOL } from "../src/mcp/orchestration/tools/AskOwnerTool/constants";
import { CANCEL_TASK_TOOL } from "../src/mcp/orchestration/tools/CancelTaskTool/constants";
import { DISPATCH_AGENT_TOOL } from "../src/mcp/orchestration/tools/DispatchAgentTool/constants";
import { FORWARD_RESULT_TOOL } from "../src/mcp/orchestration/tools/ForwardResultTool/constants";
import { REQUEST_PLAN_TOOL } from "../src/mcp/orchestration/tools/RequestPlanTool/constants";
import { STEER_TASK_TOOL } from "../src/mcp/orchestration/tools/SteerTaskTool/constants";
import { TASK_STATUS_TOOL } from "../src/mcp/orchestration/tools/TaskStatusTool/constants";
import { ANALYZE_BLOCKERS_TOOL } from "../src/mcp/plan/tools/AnalyzeBlockersTool/constants";
import { CREATE_PLAN_TOOL } from "../src/mcp/plan/tools/CreatePlanTool/constants";
import { GET_AGENT_CAPABILITIES_TOOL } from "../src/mcp/plan/tools/GetAgentCapabilitiesTool/constants";
import { GET_EXECUTION_PROGRESS_TOOL } from "../src/mcp/plan/tools/GetExecutionProgressTool/constants";
import { GET_PROJECT_CONTEXT_TOOL } from "../src/mcp/plan/tools/GetProjectContextTool/constants";
import { PROPOSE_PLAN_REVISION_TOOL } from "../src/mcp/plan/tools/ProposePlanRevisionTool/constants";
import { VALIDATE_PLAN_TOOL } from "../src/mcp/plan/tools/ValidatePlanTool/constants";
import { getRole } from "../src/roles/role-registry";

/** The lead's typed actions: no worker run may ever hold or call one of these. */
export const LEAD_ONLY_TOOLS = [
  DISPATCH_AGENT_TOOL,
  TASK_STATUS_TOOL,
  STEER_TASK_TOOL,
  CANCEL_TASK_TOOL,
  ASK_OWNER_TOOL,
  FORWARD_RESULT_TOOL,
  REQUEST_PLAN_TOOL,
  APPROVE_PLAN_TOOL,
];

/**
 * A run ctx with EVERY part present (fake: the tools are only built, never called). Tests slice it (`{ ...FULL_CTX,
 * lead: undefined }`) to model a run that lacks a part.
 */
export const FULL_CTX: RunCtx = {
  memory: {
    db: new Database(":memory:"),
    home: "/nowhere",
    workspace: "w",
    locationNames: () => [],
    threadLabel: "t",
    threadId: "t1",
    threadTitle: { rename: async () => "kept" } as never,
  },
  lead: {} as never,
  reportSink: {},
  plan: {} as never,
  effects: {} as never,
  admin: {} as never,
};

/** Tool names held by each built server: `{ <server>: [bare tool names, sorted] }`. */
export function toolsByServer(servers: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) => [
      name,
      // Test-only: `_registeredTools` is an undocumented MCP SDK internal (no public list call on the instance).
      Object.keys(
        (s as { instance: { _registeredTools: object } }).instance._registeredTools,
      ).sort(),
    ]),
  );
}

/** The `memory` server of a lead run (the only role that holds MemorySave) with this memory ctx. */
export const memoryServer = (memory: NonNullable<RunCtx["memory"]>) =>
  buildServers(getRole("lead"), { memory })[MEMORY_MCP_SERVER] as never;

/** The seven tools of the `plan` server (only the planner may hold them). */
export const PLAN_TOOLS = [
  GET_PROJECT_CONTEXT_TOOL,
  GET_AGENT_CAPABILITIES_TOOL,
  CREATE_PLAN_TOOL,
  VALIDATE_PLAN_TOOL,
  PROPOSE_PLAN_REVISION_TOOL,
  GET_EXECUTION_PROGRESS_TOOL,
  ANALYZE_BLOCKERS_TOOL,
];

/** Every bare tool name of every manifest (a role listing all of them builds every server). */
export const ALL_TOOL_NAMES = ALL_SERVERS.flatMap((s) => s.tools.map((t) => t.name));
