import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { LeadToolContext } from "../../../../orchestrator/lead/lead-call";
import { handleSteer } from "../../../../orchestrator/lead/lead-handlers";
import { STEER_TASK_SHAPE } from "../../../../orchestrator/lead/lead-schemas";
import { runTool } from "../../../tool-result";
import { STEER_TASK_TOOL } from "./constants";
import { STEER_TASK_DESCRIPTION } from "./prompt";

/** The `SteerTask` tool: strict schema + error wrapper around `handleSteer` (the rules live there). */
export function createSteerTaskTool(ctx: LeadToolContext) {
  return tool(STEER_TASK_TOOL, STEER_TASK_DESCRIPTION, STEER_TASK_SHAPE, (args) =>
    runTool(STEER_TASK_TOOL, () => handleSteer(ctx, args)),
  );
}
