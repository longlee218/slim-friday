import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ASK_OWNER_TOOL } from "../../mcp/mcp-tool-names";
import type { LeadToolContext } from "../../orchestrator/engine/lead-call";
import { handleAskOwner } from "../../orchestrator/engine/lead-handlers";
import { ASK_OWNER_SHAPE } from "../../orchestrator/engine/lead-schemas";
import { runTool } from "../lead-tool-result";
import { ASK_OWNER_DESCRIPTION } from "./prompt";

/** The `AskOwner` tool: strict schema + error wrapper around `handleAskOwner` (the rules live there). */
export function createAskOwnerTool(ctx: LeadToolContext) {
  return tool(ASK_OWNER_TOOL, ASK_OWNER_DESCRIPTION, ASK_OWNER_SHAPE, (args) =>
    runTool(ASK_OWNER_TOOL, () => handleAskOwner(ctx, args)),
  );
}
