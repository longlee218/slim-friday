import type { BotId } from "../domain/bot";
import type { Author } from "../domain/message";
import { createRun } from "../runs/run-create";
import type { RunExec } from "../runs/run-exec";
import { type Ticket, ticketRef } from "../tickets/ticket";
import { type HubContext, tell } from "./hub-context";
import { errText } from "./hub-types";
import { AUTO_BLOCK_COMMENT, isOpenWork, ticketRewakeText, ticketWakeText } from "./ticket-support";

/** Queue a run for the assignee of a ticket in its own direct conversation; nothing is posted to the channel. */
export async function wakeForTicket(
  ctx: HubContext,
  ticket: Ticket,
  botId: BotId,
  rewake = false,
  actor: Author = { kind: "system" },
): Promise<void> {
  if (ticket.status === "done" || ticket.status === "closed") return;
  const conv = await ctx.deps.store.conversations.direct(botId);
  const text = rewake ? ticketRewakeText(ticket) : ticketWakeText(ticket);
  // A bot that assigns the ticket is the sender, so the rate and repeat caps apply to it.
  const hop = actor.kind === "bot" ? 1 : 0;
  if (!conv) {
    // Kept on record: the wake could not go anywhere.
    const row = await ctx.wakeLog.create({
      conversationId: "none",
      targetBot: botId,
      sender: actor,
      intent: "request",
      hop,
      text,
      ticketId: ticket.id,
      ...(rewake && { rewake: true }),
    });
    await ctx.wakeLog.dropped(row.id);
    return;
  }
  // The ticket is saved already: a wake that cannot be stored must not fail the tool that saved it.
  try {
    await createRun(ctx, {
      botId,
      conversationId: conv.id,
      sender: actor,
      text,
      hop,
      opts: { ticketId: ticket.id, ...(rewake && { rewake: true }) },
    });
  } catch (err) {
    ctx.deps.log?.error({ error: errText(err), ticketId: ticket.id }, "hub.ticket_wake_failed");
  }
}

/**
 * After a ticket run finished normally: if the ticket is still todo/doing and the bot's, wake it once more;
 * if that wake also ended with the ticket open, block the ticket, say why and tell the conversation.
 */
export async function checkUnfinished(ctx: HubContext, e: RunExec): Promise<void> {
  const cur = e.row.ticketId ? { id: e.row.ticketId, rewake: e.row.rewake === true } : undefined;
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
