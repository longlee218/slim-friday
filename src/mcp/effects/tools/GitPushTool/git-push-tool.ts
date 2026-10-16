import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { gitPush } from "../../../../orchestrator/effects/git-push";
import type { EffectsCtx } from "../../../../policy/effect-context";
import { runTool } from "../../../tool-result";
import { GIT_PUSH_TOOL, NAME_MAX_CHARS } from "./constants";
import { GIT_PUSH_DESCRIPTION } from "./prompt";

/** Input of the tool (the model sees this schema); limits come from `constants.ts`. */
const SHAPE = {
  location: z.string().min(1).max(NAME_MAX_CHARS),
  remote: z.string().min(1).max(NAME_MAX_CHARS),
  branch: z.string().min(1).max(NAME_MAX_CHARS),
};

/** The `GitPush` tool: strict schema + error wrapper around `gitPush`. */
export function createGitPushTool(ctx: EffectsCtx) {
  return tool(GIT_PUSH_TOOL, GIT_PUSH_DESCRIPTION, SHAPE, (args) =>
    runTool(GIT_PUSH_TOOL, () => gitPush(ctx, args)),
  );
}
