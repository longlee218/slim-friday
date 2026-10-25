import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { ChatContext } from "../../chat-context";
import { POST_UPDATE_TOOL } from "./constants";
import { POST_UPDATE_CUT, POST_UPDATE_DESCRIPTION, POST_UPDATE_NOT_POSTED } from "./prompt";

/** Input the model sees (no max length here: a longer text is cut and the result says so). */
const SHAPE = {
  message: z
    .string()
    .describe("Short owner-visible update, not the final answer; cut at 500 characters."),
};

/** `PostUpdate` for one session: the hub stores the message and applies the run's progress budget. */
export function createPostUpdateTool(ctx: ChatContext) {
  return tool(POST_UPDATE_TOOL, POST_UPDATE_DESCRIPTION, SHAPE, async ({ message }) => {
    if (!message.trim()) return textResult("Refused: the message is empty.", true);
    const r = await ctx.postUpdate?.(message);
    if (!r) return textResult("Refused: there is no run to post an update for.", true);
    if (!r.posted) return textResult(POST_UPDATE_NOT_POSTED);
    return textResult(r.cut ? POST_UPDATE_CUT : "Posted.");
  });
}
