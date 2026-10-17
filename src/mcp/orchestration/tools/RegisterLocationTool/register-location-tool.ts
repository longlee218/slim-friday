import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { LeadToolContext } from "../../../../orchestrator/lead/lead-call";
import { handleRegisterLocation } from "../../../../orchestrator/lead/lead-location-handler";
import { REGISTER_LOCATION_SHAPE } from "../../../../orchestrator/lead/lead-schemas";
import { runTool } from "../../../tool-result";
import { REGISTER_LOCATION_TOOL } from "./constants";
import { REGISTER_LOCATION_DESCRIPTION } from "./prompt";

/** The `RegisterLocation` tool: strict schema + error wrapper around `handleRegisterLocation` (the rules live there). */
export function createRegisterLocationTool(ctx: LeadToolContext) {
  return tool(
    REGISTER_LOCATION_TOOL,
    REGISTER_LOCATION_DESCRIPTION,
    REGISTER_LOCATION_SHAPE,
    (args) => runTool(REGISTER_LOCATION_TOOL, () => handleRegisterLocation(ctx, args)),
  );
}
