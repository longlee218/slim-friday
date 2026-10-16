import { tool } from "@anthropic-ai/claude-agent-sdk";
import { GOAL_SHAPE } from "../../../../orchestrator/plan/plan-schemas";
import type { PlannerCtx } from "../../../../orchestrator/plan/planner-handlers";
import { getExecutionProgress } from "../../../../orchestrator/plan/progress-handlers";
import { runTool } from "../../../orchestration/lead-tool-result";
import { GET_EXECUTION_PROGRESS_TOOL } from "./constants";
import { GET_EXECUTION_PROGRESS_DESCRIPTION } from "./prompt";

/** The `GetExecutionProgress` tool: schema + error wrapper around `getExecutionProgress` (the rules live there). */
export function createGetExecutionProgressTool(ctx: PlannerCtx) {
  return tool(
    GET_EXECUTION_PROGRESS_TOOL,
    GET_EXECUTION_PROGRESS_DESCRIPTION,
    GOAL_SHAPE,
    async (args) =>
      runTool(GET_EXECUTION_PROGRESS_TOOL, async () => getExecutionProgress(ctx, args)),
  );
}
