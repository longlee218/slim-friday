import { tool } from "@anthropic-ai/claude-agent-sdk";
import { GOAL_SHAPE } from "../../../../orchestrator/plan/plan-schemas";
import type { PlannerCtx } from "../../../../orchestrator/plan/planner-handlers";
import { analyzeBlockers } from "../../../../orchestrator/plan/progress-handlers";
import { runTool } from "../../../orchestration/lead-tool-result";
import { ANALYZE_BLOCKERS_TOOL } from "./constants";
import { ANALYZE_BLOCKERS_DESCRIPTION } from "./prompt";

/** The `AnalyzeBlockers` tool: schema + error wrapper around `analyzeBlockers` (the rules live there). */
export function createAnalyzeBlockersTool(ctx: PlannerCtx) {
  return tool(ANALYZE_BLOCKERS_TOOL, ANALYZE_BLOCKERS_DESCRIPTION, GOAL_SHAPE, async (args) =>
    runTool(ANALYZE_BLOCKERS_TOOL, async () => analyzeBlockers(ctx, args)),
  );
}
