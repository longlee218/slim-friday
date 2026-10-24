import { tool } from "@anthropic-ai/claude-agent-sdk";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@friday/core";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { resolveBot, type TicketsContext, ticketView } from "../../tickets-context";
import { TICKET_LIST_TOOL } from "./constants";
import { TICKET_LIST_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  status: z.enum(TICKET_STATUSES).optional().describe("Only tickets in this status."),
  assignee: z.string().optional().describe("Only tickets of this bot (id or exact name)."),
  cursor: z.string().optional().describe("The nextCursor of the previous page."),
};

/** `TicketList` for one session. */
export function createTicketListTool(ctx: TicketsContext) {
  return tool(
    TICKET_LIST_TOOL,
    TICKET_LIST_DESCRIPTION,
    SHAPE,
    async ({ status, assignee, cursor }) => {
      let assigneeBotId: string | undefined;
      if (assignee !== undefined) {
        assigneeBotId = await resolveBot(ctx, assignee);
        if (!assigneeBotId) return textResult("Unknown bot.", true);
      }
      const r = await ctx.board.list({
        ...(status && { status }),
        ...(assigneeBotId && { assigneeBotId }),
        ...(cursor && { cursor }),
      });
      if (!r.ok) return textResult(r.error, true);
      return textResult(
        JSON.stringify({ tickets: r.tickets.map(ticketView), nextCursor: r.nextCursor }),
      );
    },
  );
}
