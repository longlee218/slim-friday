import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { PEER_MESSAGE_MAX_CHARS } from "../../../../config/teammate-caps";
import { PEER_INTENTS } from "../../../../teammates/peer/send-peer-message";
import type { PeerCtx } from "../../../manifest-types";
import { textResult } from "../../../tool-result";
import { MESSAGE_TEAMMATE_TOOL } from "./constants";
import { MESSAGE_TEAMMATE_DESCRIPTION } from "./prompt";

const SHAPE = {
  to: z.string().min(1).describe("Name of the target teammate."),
  text: z.string().min(1).describe(`The message (at most ${PEER_MESSAGE_MAX_CHARS} characters).`),
  intent: z.enum(PEER_INTENTS),
  replyTo: z.number().int().positive().optional().describe("P-number of the message you answer."),
};

/** The `MessageTeammate` tool of ONE teammate run. */
export function createMessageTeammateTool(ctx: PeerCtx) {
  return tool(MESSAGE_TEAMMATE_TOOL, MESSAGE_TEAMMATE_DESCRIPTION, SHAPE, async (args) => {
    const r = await ctx.deliver(args);
    return textResult(JSON.stringify(r.ok ? { ok: true, messageId: r.id } : r), !r.ok);
  });
}
