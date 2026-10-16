import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { LeadToolContext } from "../../../../orchestrator/engine/lead-call";
import { handleCancel } from "../../../../orchestrator/engine/lead-handlers";
import { CANCEL_TASK_SHAPE } from "../../../../orchestrator/engine/lead-schemas";
import { runTool } from "../../lead-tool-result";
import { CANCEL_TASK_TOOL } from "./constants";
import { CANCEL_TASK_DESCRIPTION } from "./prompt";

/** The `CancelTask` tool: strict schema + error wrapper around `handleCancel` (the rules live there). */
export function createCancelTaskTool(ctx: LeadToolContext) {
  return tool(CANCEL_TASK_TOOL, CANCEL_TASK_DESCRIPTION, CANCEL_TASK_SHAPE, (args) =>
    runTool(CANCEL_TASK_TOOL, () => handleCancel(ctx, args)),
  );
}
