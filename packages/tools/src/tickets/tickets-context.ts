import {
  type BotId,
  type ConversationId,
  finished,
  type GroupId,
  type Store,
  type Ticket,
  type TicketBoard,
  ticketRef,
} from "@friday/core";

/** What the ticket tools of one session need: who is acting, the board, and the bots to resolve assignees. */
export interface TicketsContext {
  botId: BotId;
  board: TicketBoard;
  bots: Pick<Store, "bots">["bots"];
  /** The conversation the session is working in now (read when the tool runs); recorded on the ticket. */
  /** The group of the session: a group-chat or ticket session; unset in the direct session. */
  groupId?: GroupId;
  conversation?: () => ConversationId | undefined;
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

/** The tickets `t` waits on, in `blockedBy` order; one that no longer exists is skipped. */
async function blockersOf(ctx: TicketsContext, t: Ticket): Promise<Ticket[]> {
  const found = await Promise.all((t.blockedBy ?? []).map((id) => ctx.board.get(id)));
  return found.flatMap((r) => (r.ok ? [r.ticket] : []));
}

/** A ticket as the model reads it: the ref first, no internal fields; blockers as refs. */
export async function ticketView(ctx: TicketsContext, t: Ticket) {
  const blockers = await blockersOf(ctx, t);
  return {
    ref: ticketRef(t.number),
    id: t.id,
    title: t.title,
    ...(t.description !== undefined && { description: t.description }),
    status: t.status,
    ...(blockers.length > 0 && { blockedBy: blockers.map((b) => ticketRef(b.number)) }),
    ...(blockers.some((b) => !finished(b.status)) && {
      waitingOn: blockers.filter((b) => !finished(b.status)).map((b) => ticketRef(b.number)),
    }),
    ...(t.blockedReason !== undefined && { blockedReason: t.blockedReason }),
    ...(t.conversationId !== undefined && { conversationId: t.conversationId }),
    priority: t.priority,
    ...(t.assigneeBotId && { assignee: t.assigneeBotId }),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(t.completedAt !== undefined && { completedAt: t.completedAt }),
  };
}
