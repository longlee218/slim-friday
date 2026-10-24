import { tool } from "@anthropic-ai/claude-agent-sdk";
import { WAKE_INTENTS } from "@friday/core";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { ChatContext } from "../../chat-context";
import { SEND_TO_BOT_TOOL } from "./constants";
import { SEND_TO_BOT_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  to: z.string().describe("The id or exact name of a member of your group."),
  message: z.string().describe("What the member needs to know or do (the real content)."),
  intent: z.enum(WAKE_INTENTS).describe("What you expect of the member."),
};

/** `SendToBot` for one session: the hub checks the target, the caps and wakes the member. */
export function createSendToBotTool(ctx: ChatContext) {
  return tool(SEND_TO_BOT_TOOL, SEND_TO_BOT_DESCRIPTION, SHAPE, async ({ to, message, intent }) => {
    const r = await ctx.messenger?.send(ctx.botId, { to, text: message, intent });
    if (!r) return textResult("Refused: you are in no group.", true);
    return r.ok ? textResult(r.note) : textResult(r.error, true);
  });
}
