import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { LeadToolContext } from "../../../../orchestrator/lead/lead-call";
import { handleForward } from "../../../../orchestrator/lead/lead-handlers";
import { FORWARD_RESULT_SHAPE } from "../../../../orchestrator/lead/lead-schemas";
import { runTool } from "../../../tool-result";
import { FORWARD_RESULT_TOOL } from "./constants";
import { FORWARD_RESULT_DESCRIPTION } from "./prompt";

/** The `ForwardResult` tool: strict schema + error wrapper around `handleForward` (the rules live there). */
export function createForwardResultTool(ctx: LeadToolContext) {
  return tool(FORWARD_RESULT_TOOL, FORWARD_RESULT_DESCRIPTION, FORWARD_RESULT_SHAPE, (args) =>
    runTool(FORWARD_RESULT_TOOL, () => handleForward(ctx, args)),
  );
}
