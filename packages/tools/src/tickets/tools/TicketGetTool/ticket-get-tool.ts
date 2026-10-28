import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { type TicketsContext, ticketView } from "../../tickets-context";
import { TICKET_GET_TOOL } from "./constants";
import { TICKET_GET_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  ref: z.string().describe("A ticket ref such as FRI-3, or a ticket id."),
};

/** `TicketGet` for one session. */
export function createTicketGetTool(ctx: TicketsContext) {
  return tool(TICKET_GET_TOOL, TICKET_GET_DESCRIPTION, SHAPE, async ({ ref }) => {
    const r = await ctx.board.get(ref);
    if (!r.ok) return textResult(r.error, true);
    return textResult(
      JSON.stringify({
        ticket: await ticketView(ctx, r.ticket),
        comments: r.comments.map((c) => ({
          author: c.author.kind === "bot" ? c.author.botId : c.author.kind,
          body: c.body,
          at: c.createdAt,
        })),
      }),
    );
  });
}
