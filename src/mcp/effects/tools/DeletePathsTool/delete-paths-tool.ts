import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { deletePaths } from "../../../../orchestrator/approval/delete-paths";
import type { EffectsCtx } from "../../../../orchestrator/approval/effect-context";
import { runTool } from "../../../orchestration/lead-tool-result";
import { DELETE_PATHS_TOOL, MAX_PATHS, PATH_MAX_CHARS, REASON_MAX_CHARS } from "./constants";
import { DELETE_PATHS_DESCRIPTION } from "./prompt";

const SHAPE = {
  paths: z.array(z.string().min(1).max(PATH_MAX_CHARS)).min(1).max(MAX_PATHS),
  reason: z.string().min(1).max(REASON_MAX_CHARS),
};

/** The `DeletePaths` tool: strict schema + error wrapper around `deletePaths` (the rules live there). */
export function createDeletePathsTool(ctx: EffectsCtx) {
  return tool(DELETE_PATHS_TOOL, DELETE_PATHS_DESCRIPTION, SHAPE, (args) =>
    runTool(DELETE_PATHS_TOOL, () => deletePaths(ctx, args)),
  );
}
