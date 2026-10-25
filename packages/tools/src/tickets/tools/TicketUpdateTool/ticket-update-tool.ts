import { tool } from "@anthropic-ai/claude-agent-sdk";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@friday/core";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { resolveBot, type TicketsContext, ticketView } from "../../tickets-context";
import { TICKET_UPDATE_TOOL } from "./constants";
import { TICKET_UPDATE_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  id: z.string().describe("A ticket ref such as FRI-3, or a ticket id."),
  title: z.string().optional(),
  description: z.string().nullable().optional().describe("null clears it."),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  assignee: z.string().optional().describe("A bot id or exact name."),
  blockedReason: z.string().max(500).optional().describe("Required when status is blocked: why."),
};

/** `TicketUpdate` for one session: the actor is the session's bot. */
export function createTicketUpdateTool(ctx: TicketsContext) {
  return tool(TICKET_UPDATE_TOOL, TICKET_UPDATE_DESCRIPTION, SHAPE, async (i) => {
    let assigneeBotId: string | undefined;
    if (i.assignee !== undefined) {
      assigneeBotId = await resolveBot(ctx, i.assignee);
      if (!assigneeBotId) return textResult("Unknown bot.", true);
    }
    const conversationId = ctx.conversation?.();
    const r = await ctx.board.update(
      { kind: "bot", botId: ctx.botId },
      {
        id: i.id,
        ...(i.title !== undefined && { title: i.title }),
        ...(i.description !== undefined && { description: i.description }),
        ...(i.priority && { priority: i.priority }),
        ...(i.status && { status: i.status }),
        ...(assigneeBotId && { assigneeBotId }),
        ...(i.blockedReason !== undefined && { blockedReason: i.blockedReason }),
        ...(conversationId && { conversationId }),
      },
    );
    return r.ok ? textResult(JSON.stringify(ticketView(r.ticket))) : textResult(r.error, true);
  });
}
