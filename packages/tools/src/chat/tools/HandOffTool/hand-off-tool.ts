import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { ChatContext } from "../../chat-context";
import { HAND_OFF_TOOL } from "./constants";
import { HAND_OFF_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  to: z.string().describe("The id or exact name of the member that takes the step."),
  task: z.string().describe("Everything the member needs to do the step."),
};

/** `HandOff` for one session: a request the receiver owns, with no answer back to the sender. */
export function createHandOffTool(ctx: ChatContext) {
  return tool(
    HAND_OFF_TOOL,
    HAND_OFF_DESCRIPTION,
    SHAPE,
    async ({ to, task }) => {
      const r = await ctx.messenger?.send(ctx.botId, {
        to,
        text: task,
        intent: "request",
        handoff: true,
      });
      if (!r) return textResult("Refused: you are in no group.", true);
      return r.ok ? textResult(r.note) : textResult(r.error, true);
    },
    { alwaysLoad: true },
  );
}
