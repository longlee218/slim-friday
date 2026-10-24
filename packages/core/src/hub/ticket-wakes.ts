import type { BotId } from "../domain/bot";
import type { Author } from "../domain/message";
import { type Ticket, ticketRef } from "../tickets/ticket";
import { type HubContext, tell } from "./hub-context";
import { errText } from "./hub-types";
import type { PoolEntry } from "./session-pool";
import { AUTO_BLOCK_COMMENT, isOpenWork, ticketRewakeText, ticketWakeText } from "./ticket-support";

/** Wake the assignee of a ticket in its own direct conversation; nothing is posted to the channel. */
export async function wakeForTicket(
  ctx: HubContext,
  ticket: Ticket,
  botId: BotId,
  rewake = false,
  actor: Author = { kind: "system" },
): Promise<void> {
  if (ticket.status === "done" || ticket.status === "closed") return;
  const { store } = ctx.deps;
  const conv = await store.conversations.direct(botId);
  const row = await ctx.wakeLog.create({
    conversationId: conv?.id ?? "none",
    targetBot: botId,
    // A bot that assigns the ticket is the sender, so the rate and repeat caps apply to it.
    sender: actor,
    intent: "request",
    hop: actor.kind === "bot" ? 1 : 0,
    text: rewake ? ticketRewakeText(ticket) : ticketWakeText(ticket),
    ticketId: ticket.id,
    ...(rewake && { rewake: true }),
  });
  const bot = await store.bots.get(botId);
  if (!conv || !bot) {
    await ctx.wakeLog.dropped(row.id);
    return;
  }
  // The ticket is saved already: a wake that cannot be delivered must not fail the tool that saved it.
  try {
    await ctx.admit(row, bot);
  } catch (err) {
    ctx.deps.log?.error({ error: errText(err), wakeId: row.id }, "hub.ticket_wake_failed");
    await ctx.wakeLog.dropped(row.id).catch(() => {});
  }
}

/**
 * After a normal turn end of a ticket wake: if the ticket is still todo/doing and the bot's, wake it once more;
 * if that wake also ended with the ticket open, block the ticket, say why and tell the conversation.
 */
export async function checkUnfinished(ctx: HubContext, e: PoolEntry): Promise<void> {
  const cur = e.currentTicket;
  e.currentTicket = undefined;
  if (!cur) return;
  try {
    const { store } = ctx.deps;
    const t = await store.tickets.get(cur.id);
    if (!t || t.assigneeBotId !== e.bot.id || !isOpenWork(t)) return;
    if (!cur.rewake) return await wakeForTicket(ctx, t, e.bot.id, true);
    // Through the board: it records a status change by the system and keeps the reason on the ticket.
    const blocked = await ctx.tickets.update(
      { kind: "system" },
      { id: t.id, status: "blocked", blockedReason: AUTO_BLOCK_COMMENT },
    );
    // A refused block (the ticket changed or vanished) leaves no comment and no notice.
    if (!blocked.ok) return;
    // The board's own comment, so `onChange` carries the right comment count.
    await ctx.tickets.comment({ kind: "system" }, { id: t.id, body: AUTO_BLOCK_COMMENT });
    await tell(
      ctx,
      e.current.conversationId,
      `Ticket ${ticketRef(t.number)} was left open after two turns and is now blocked.`,
    );
  } catch (err) {
    ctx.deps.log?.error({ error: errText(err), botId: e.bot.id }, "hub.unfinished_check_failed");
  }
}
