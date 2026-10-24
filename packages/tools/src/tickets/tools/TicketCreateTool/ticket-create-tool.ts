import { tool } from "@anthropic-ai/claude-agent-sdk";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@friday/core";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { resolveBot, type TicketsContext, ticketView } from "../../tickets-context";
import { TICKET_CREATE_TOOL } from "./constants";
import { TICKET_CREATE_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  title: z.string().describe("Short title, 1-200 characters."),
  description: z.string().optional().describe("What is needed and how to know it is done."),
  priority: z.enum(TICKET_PRIORITIES).optional().describe("Default normal."),
  assignee: z.string().optional().describe("A bot id or exact name; default you."),
};

/** `TicketCreate` for one session: the actor is the session's bot. */
export function createTicketCreateTool(ctx: TicketsContext) {
  return tool(TICKET_CREATE_TOOL, TICKET_CREATE_DESCRIPTION, SHAPE, async (i) => {
    let assigneeBotId: string | undefined;
    if (i.assignee !== undefined) {
      assigneeBotId = await resolveBot(ctx, i.assignee);
      if (!assigneeBotId) return textResult("Unknown bot.", true);
    }
    const r = await ctx.board.create(
      { kind: "bot", botId: ctx.botId },
      {
        title: i.title,
        ...(i.description && { description: i.description }),
        ...(i.priority && { priority: i.priority }),
        ...(assigneeBotId && { assigneeBotId }),
      },
    );
    return r.ok ? textResult(JSON.stringify(ticketView(r.ticket))) : textResult(r.error, true);
  });
}
