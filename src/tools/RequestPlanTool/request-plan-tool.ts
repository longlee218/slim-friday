import { tool } from "@anthropic-ai/claude-agent-sdk";
import { REQUEST_PLAN_TOOL } from "../../mcp/mcp-tool-names";
import type { LeadToolContext } from "../../orchestrator/engine/lead-call";
import { handleRequestPlan } from "../../orchestrator/engine/lead-plan-handlers";
import { REQUEST_PLAN_SHAPE } from "../../orchestrator/plan/plan-schemas";
import { runTool } from "../lead-tool-result";
import { REQUEST_PLAN_DESCRIPTION } from "./prompt";

/** The `RequestPlan` tool: strict schema + error wrapper around `handleRequestPlan` (the rules live there). */
export function createRequestPlanTool(ctx: LeadToolContext) {
  return tool(REQUEST_PLAN_TOOL, REQUEST_PLAN_DESCRIPTION, REQUEST_PLAN_SHAPE, (args) =>
    runTool(REQUEST_PLAN_TOOL, () => handleRequestPlan(ctx, args)),
  );
}
