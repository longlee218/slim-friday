import { tool } from "@anthropic-ai/claude-agent-sdk";
import { PROPOSE_REVISION_SHAPE } from "../../../../orchestrator/plan/plan-schemas";
import {
  type PlannerCtx,
  proposeRevisionHandler,
} from "../../../../orchestrator/plan/planner-handlers";
import { runTool } from "../../../tool-result";
import { PROPOSE_PLAN_REVISION_TOOL } from "./constants";
import { PROPOSE_PLAN_REVISION_DESCRIPTION } from "./prompt";

/** The `ProposePlanRevision` tool: schema + error wrapper around `proposeRevisionHandler` (the rules live there). */
export function createProposePlanRevisionTool(ctx: PlannerCtx) {
  return tool(
    PROPOSE_PLAN_REVISION_TOOL,
    PROPOSE_PLAN_REVISION_DESCRIPTION,
    PROPOSE_REVISION_SHAPE,
    async (args) =>
      runTool(PROPOSE_PLAN_REVISION_TOOL, async () => proposeRevisionHandler(ctx, args)),
  );
}
