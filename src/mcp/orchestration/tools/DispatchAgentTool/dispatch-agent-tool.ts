import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { LeadToolContext } from "../../../../orchestrator/engine/lead-call";
import { handleDispatch } from "../../../../orchestrator/engine/lead-handlers";
import { DISPATCH_AGENT_SHAPE } from "../../../../orchestrator/engine/lead-schemas";
import { runTool } from "../../../tool-result";
import { DISPATCH_AGENT_TOOL } from "./constants";
import { DISPATCH_AGENT_DESCRIPTION } from "./prompt";

/** The `DispatchAgent` tool: strict schema + error wrapper around `handleDispatch` (the rules live there). */
export function createDispatchAgentTool(ctx: LeadToolContext) {
  return tool(DISPATCH_AGENT_TOOL, DISPATCH_AGENT_DESCRIPTION, DISPATCH_AGENT_SHAPE, (args) =>
    runTool(DISPATCH_AGENT_TOOL, () => handleDispatch(ctx, args)),
  );
}
