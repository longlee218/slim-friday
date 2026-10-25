import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { TicketsContext } from "../../tickets-context";
import { TICKET_COMMENT_TOOL } from "./constants";
import { TICKET_COMMENT_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  id: z.string().describe("A ticket ref such as FRI-3, or a ticket id."),
  body: z.string().describe("The comment, 1-10000 characters."),
};

/** `TicketComment` for one session: the author is the session's bot. */
export function createTicketCommentTool(ctx: TicketsContext) {
  return tool(TICKET_COMMENT_TOOL, TICKET_COMMENT_DESCRIPTION, SHAPE, async ({ id, body }) => {
    const conversationId = ctx.conversation?.();
    const r = await ctx.board.comment(
      { kind: "bot", botId: ctx.botId },
      { id, body, ...(conversationId && { conversationId }) },
    );
    return r.ok ? textResult("Comment added.") : textResult(r.error, true);
  });
}
