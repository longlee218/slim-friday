import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { LeadToolContext } from "../../../../orchestrator/engine/lead-call";
import { handleApprovePlan } from "../../../../orchestrator/engine/lead-plan-handlers";
import { APPROVE_PLAN_SHAPE } from "../../../../orchestrator/plan/plan-schemas";
import { runTool } from "../../../tool-result";
import { APPROVE_PLAN_TOOL } from "./constants";
import { APPROVE_PLAN_DESCRIPTION } from "./prompt";

/** The `ApprovePlan` tool: strict schema + error wrapper around `handleApprovePlan` (the rules live there). */
export function createApprovePlanTool(ctx: LeadToolContext) {
  return tool(APPROVE_PLAN_TOOL, APPROVE_PLAN_DESCRIPTION, APPROVE_PLAN_SHAPE, (args) =>
    runTool(APPROVE_PLAN_TOOL, () => handleApprovePlan(ctx, args)),
  );
}
