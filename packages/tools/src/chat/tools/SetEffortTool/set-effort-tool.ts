import { tool } from "@anthropic-ai/claude-agent-sdk";
import { EFFORT_LEVELS, effortAtMost } from "@friday/core";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { ChatContext } from "../../chat-context";
import { SET_EFFORT_TOOL } from "./constants";
import { SET_EFFORT_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  level: z.enum(EFFORT_LEVELS).describe("The effort level to think at from now on."),
};

/** `SetEffort` for one session: changes the live session's effort, never above the bot's `maxEffort`. */
export function createSetEffortTool(ctx: ChatContext) {
  return tool(SET_EFFORT_TOOL, SET_EFFORT_DESCRIPTION, SHAPE, async ({ level }) => {
    const { max, apply } = ctx.effort;
    if (!max || !apply) return textResult("Refused: this bot cannot change its effort.", true);
    if (!effortAtMost(level, max))
      return textResult(`Refused: the highest level you may use is ${max}.`, true);
    try {
      await apply(level);
    } catch {
      return textResult("Refused: the effort could not be changed in this session.", true);
    }
    return textResult(`Effort is now ${level}.`);
  });
}
