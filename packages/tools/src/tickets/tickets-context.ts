import { type BotId, type Store, type Ticket, type TicketBoard, ticketRef } from "@friday/core";

/** What the ticket tools of one session need: who is acting, the board, and the bots to resolve assignees. */
export interface TicketsContext {
  botId: BotId;
  board: TicketBoard;
  bots: Pick<Store, "bots">["bots"];
}

/** A bot id from an id or an exact name (any case); undefined when no bot matches. */
export async function resolveBot(
  ctx: TicketsContext,
  idOrName: string,
): Promise<BotId | undefined> {
  const byId = await ctx.bots.get(idOrName);
  if (byId) return byId.id;
  const wanted = idOrName.trim().toLowerCase();
  return (await ctx.bots.list()).find((b) => b.name.toLowerCase() === wanted)?.id;
}

/** A ticket as the model reads it: the ref first, no internal fields. */
export function ticketView(t: Ticket) {
  return {
    ref: ticketRef(t.number),
    id: t.id,
    title: t.title,
    ...(t.description !== undefined && { description: t.description }),
    status: t.status,
    priority: t.priority,
    ...(t.assigneeBotId && { assignee: t.assigneeBotId }),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(t.completedAt !== undefined && { completedAt: t.completedAt }),
  };
}
