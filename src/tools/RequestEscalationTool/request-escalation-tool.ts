import { tool } from "@anthropic-ai/claude-agent-sdk";
import { REQUEST_ESCALATION_TOOL } from "../../mcp/mcp-tool-names";
import type { LeadToolContext } from "../../orchestrator/engine/lead-call";
import { handleEscalation } from "../../orchestrator/engine/lead-handlers";
import { REQUEST_ESCALATION_SHAPE } from "../../orchestrator/engine/lead-schemas";
import { runTool } from "../lead-tool-result";
import { REQUEST_ESCALATION_DESCRIPTION } from "./prompt";

/** The `RequestEscalation` tool: strict schema + error wrapper around `handleEscalation` (the rules live there). */
export function createRequestEscalationTool(ctx: LeadToolContext) {
  return tool(
    REQUEST_ESCALATION_TOOL,
    REQUEST_ESCALATION_DESCRIPTION,
    REQUEST_ESCALATION_SHAPE,
    (args) => runTool(REQUEST_ESCALATION_TOOL, () => handleEscalation(ctx, args)),
  );
}
