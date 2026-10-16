import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  getAgentCapabilities,
  type PlannerCtx,
} from "../../../../orchestrator/plan/planner-handlers";
import { runTool } from "../../../orchestration/lead-tool-result";
import { GET_AGENT_CAPABILITIES_TOOL } from "./constants";
import { GET_AGENT_CAPABILITIES_DESCRIPTION } from "./prompt";

/** The `GetAgentCapabilities` tool: schema + error wrapper around `getAgentCapabilities` (the rules live there). */
export function createGetAgentCapabilitiesTool(ctx: PlannerCtx) {
  return tool(GET_AGENT_CAPABILITIES_TOOL, GET_AGENT_CAPABILITIES_DESCRIPTION, {}, async (_args) =>
    runTool(GET_AGENT_CAPABILITIES_TOOL, async () => getAgentCapabilities(ctx)),
  );
}
