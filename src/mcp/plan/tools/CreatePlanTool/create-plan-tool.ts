import { tool } from "@anthropic-ai/claude-agent-sdk";
import { CREATE_PLAN_SHAPE } from "../../../../orchestrator/plan/plan-schemas";
import { createPlanHandler, type PlannerCtx } from "../../../../orchestrator/plan/planner-handlers";
import { runTool } from "../../../tool-result";
import { CREATE_PLAN_TOOL } from "./constants";
import { CREATE_PLAN_DESCRIPTION } from "./prompt";

/** The `CreatePlan` tool: schema + error wrapper around `createPlanHandler` (the rules live there). */
export function createCreatePlanTool(ctx: PlannerCtx) {
  return tool(CREATE_PLAN_TOOL, CREATE_PLAN_DESCRIPTION, CREATE_PLAN_SHAPE, async (args) =>
    runTool(CREATE_PLAN_TOOL, async () => createPlanHandler(ctx, args)),
  );
}
