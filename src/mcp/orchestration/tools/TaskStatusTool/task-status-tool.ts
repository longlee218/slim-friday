import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { LeadToolContext } from "../../../../orchestrator/engine/lead-call";
import { handleTaskStatus } from "../../../../orchestrator/engine/lead-handlers";
import { TASK_STATUS_SHAPE } from "../../../../orchestrator/engine/lead-schemas";
import { runTool } from "../../lead-tool-result";
import { TASK_STATUS_TOOL } from "./constants";
import { TASK_STATUS_DESCRIPTION } from "./prompt";

/** The task status tool: strict schema + error wrapper around `handleTaskStatus` (the rules live there). */
export function createTaskStatusTool(ctx: LeadToolContext) {
  return tool(TASK_STATUS_TOOL, TASK_STATUS_DESCRIPTION, TASK_STATUS_SHAPE, (args) =>
    runTool(TASK_STATUS_TOOL, () => handleTaskStatus(ctx, args)),
  );
}
