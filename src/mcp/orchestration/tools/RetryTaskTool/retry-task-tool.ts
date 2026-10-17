import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { LeadToolContext } from "../../../../orchestrator/lead/lead-call";
import { handleRetry } from "../../../../orchestrator/lead/lead-retry-handler";
import { RETRY_TASK_SHAPE } from "../../../../orchestrator/lead/lead-schemas";
import { runTool } from "../../../tool-result";
import { RETRY_TASK_TOOL } from "./constants";
import { RETRY_TASK_DESCRIPTION } from "./prompt";

/** The `RetryTask` tool: strict schema + error wrapper around `handleRetry` (the rules live there). */
export function createRetryTaskTool(ctx: LeadToolContext) {
  return tool(RETRY_TASK_TOOL, RETRY_TASK_DESCRIPTION, RETRY_TASK_SHAPE, (args) =>
    runTool(RETRY_TASK_TOOL, () => handleRetry(ctx, args)),
  );
}
