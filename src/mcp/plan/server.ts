import type { McpServerManifest } from "../manifest-types";
import { PLAN_MCP_SERVER } from "../mcp-tool-names";
import { PLAN_TOOL } from "./tools/PlanTool/constants";
import { createPlanTool } from "./tools/PlanTool/plan-tool";

/**
 * The `plan` server: the planner reads the project and writes plan rows only (the ctx binds the run to its goal).
 * It holds one action tool, `Plan`, and no lead tool and no effect tool.
 */
export const PLAN_SERVER: McpServerManifest = {
  name: PLAN_MCP_SERVER,
  tools: [{ name: PLAN_TOOL, create: (c) => c.plan && createPlanTool(c.plan) }],
};
