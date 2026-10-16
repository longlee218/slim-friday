import { tool } from "@anthropic-ai/claude-agent-sdk";
import { VALIDATE_PLAN_SHAPE } from "../../../../orchestrator/plan/plan-schemas";
import {
  type PlannerCtx,
  validatePlanHandler,
} from "../../../../orchestrator/plan/planner-handlers";
import { runTool } from "../../../tool-result";
import { VALIDATE_PLAN_TOOL } from "./constants";
import { VALIDATE_PLAN_DESCRIPTION } from "./prompt";

/** The `ValidatePlan` tool: schema + error wrapper around `validatePlanHandler` (the rules live there). */
export function createValidatePlanTool(ctx: PlannerCtx) {
  return tool(VALIDATE_PLAN_TOOL, VALIDATE_PLAN_DESCRIPTION, VALIDATE_PLAN_SHAPE, async (args) =>
    runTool(VALIDATE_PLAN_TOOL, async () => validatePlanHandler(ctx, args)),
  );
}
