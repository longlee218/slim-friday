import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mergeBranch } from "../../../../effects/merge-branch";
import type { EffectsCtx } from "../../../../policy/effect-context";
import { runTool } from "../../../tool-result";
import { MERGE_BRANCH_TOOL, NAME_MAX_CHARS } from "./constants";
import { MERGE_BRANCH_DESCRIPTION } from "./prompt";

/** Input of the tool (the model sees this schema); limits come from `constants.ts`. */
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
