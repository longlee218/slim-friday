import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { EffectsCtx } from "../../../../orchestrator/approval/effect-context";
import { mergeBranch } from "../../../../orchestrator/approval/merge-branch";
import { runTool } from "../../../orchestration/lead-tool-result";
import { MERGE_BRANCH_TOOL, NAME_MAX_CHARS } from "./constants";
import { MERGE_BRANCH_DESCRIPTION } from "./prompt";

const SHAPE = {
  location: z.string().min(1).max(NAME_MAX_CHARS),
  from: z.string().min(1).max(NAME_MAX_CHARS),
  into: z.string().min(1).max(NAME_MAX_CHARS),
};

/** The `MergeBranch` tool: strict schema + error wrapper around `mergeBranch`. */
export function createMergeBranchTool(ctx: EffectsCtx) {
  return tool(MERGE_BRANCH_TOOL, MERGE_BRANCH_DESCRIPTION, SHAPE, (args) =>
    runTool(MERGE_BRANCH_TOOL, () => mergeBranch(ctx, args)),
  );
}
