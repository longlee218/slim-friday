import { tool } from "@anthropic-ai/claude-agent-sdk";
import { GOAL_SHAPE } from "../../../../orchestrator/plan/plan-schemas";
import { getProjectContext, type PlannerCtx } from "../../../../orchestrator/plan/planner-handlers";
import { runTool } from "../../../orchestration/lead-tool-result";
import { GET_PROJECT_CONTEXT_TOOL } from "./constants";
import { GET_PROJECT_CONTEXT_DESCRIPTION } from "./prompt";

/** The `GetProjectContext` tool: schema + error wrapper around `getProjectContext` (the rules live there). */
export function createGetProjectContextTool(ctx: PlannerCtx) {
  return tool(GET_PROJECT_CONTEXT_TOOL, GET_PROJECT_CONTEXT_DESCRIPTION, GOAL_SHAPE, async (args) =>
    runTool(GET_PROJECT_CONTEXT_TOOL, async () => getProjectContext(ctx, args)),
  );
}
