import { tool } from "@anthropic-ai/claude-agent-sdk";
import { TICKET_PRIORITIES } from "@friday/core";
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
  blockedBy: z
    .array(z.string())
    .optional()
    .describe("Refs like FRI-3 this ticket waits on; it starts by itself when all are done."),
};

/** `TicketCreate` for one session: the actor is the session's bot. */
export function createTicketCreateTool(ctx: TicketsContext) {
  return tool(TICKET_CREATE_TOOL, TICKET_CREATE_DESCRIPTION, SHAPE, async (i) => {
    let assigneeBotId: string | undefined;
    if (i.assignee !== undefined) {
      assigneeBotId = await resolveBot(ctx, i.assignee);
      if (!assigneeBotId) return textResult("Unknown bot.", true);
    }
    const conversationId = ctx.conversation?.();
    const r = await ctx.board.create(
      { kind: "bot", botId: ctx.botId },
      {
        title: i.title,
        ...(i.description && { description: i.description }),
        ...(i.priority && { priority: i.priority }),
        ...(i.blockedBy && { blockedBy: i.blockedBy }),
        ...(assigneeBotId && { assigneeBotId }),
        ...(conversationId && { conversationId }),
        ...(ctx.groupId && { groupId: ctx.groupId }),
      },
    );
    return r.ok
      ? textResult(JSON.stringify(await ticketView(ctx, r.ticket)))
      : textResult(r.error, true);
  });
}
