import type { BotId } from "../domain/bot";
import type { Author } from "../domain/message";
import { createRun } from "../runs/run-create";
import { type Ticket, ticketRef } from "../tickets/ticket";
import type { StatusChange } from "../tickets/ticket-board";
import { type HubContext, tell } from "./hub-context";
import { errText } from "./hub-types";
import { blockedWakeText, isOpenWork, reviewWakeText, sentBackWakeText } from "./ticket-support";
import { wakeForTicket } from "./ticket-wakes";

/** The body of the ticket's newest comment, if any. */
const lastComment = async (ctx: HubContext, t: Ticket): Promise<string | undefined> =>
  (await ctx.deps.store.tickets.comments(t.id)).at(-1)?.body;

/** Is `a` the bot `botId`? */
const isBot = (a: Author, botId: BotId | undefined): boolean =>
  a.kind === "bot" && botId !== undefined && a.botId === botId;

/**
 * After a saved status change, close the loop between a ticket's creator and its assignee:
 * - the assignee (or the system) sets review/blocked on a ticket another bot created: wake the creator;
 * - the creator bot (or the owner) moves it from review/blocked back to todo/doing: wake the assignee;
 * - the assignee sets review on an owner's direct ticket: tell its conversation.
 * Only these role-and-status pairs wake anyone (a creator setting done wakes nobody), and each wake is keyed
 * by the saved event, so a replay finds the first run. Never throws: a failure is logged.
 */
export async function followUpStatus(
  ctx: HubContext,
  t: Ticket,
  change: StatusChange,
): Promise<void> {
  try {
    const { from, actor } = change;
    const dedupeKey = `ticket-event:${change.eventId}`;
    const creator = t.createdBy.kind === "bot" ? t.createdBy.botId : undefined;
    const assignee = t.assigneeBotId;
    if (
      (t.status === "review" || t.status === "blocked") &&
      (actor.kind === "system" || isBot(actor, assignee))
    ) {
      if (creator && creator !== assignee)
        return await wakeCreator(ctx, t, creator, actor, dedupeKey);
      // Group tickets get the group milestone instead.
      if (t.status === "review" && t.createdBy.kind === "user" && !t.groupId && t.conversationId)
        await tell(
          ctx,
          t.conversationId,
          `${ticketRef(t.number)} is ready for your review: ${t.title}`,
        );
      return;
    }
    const sentBack = (from === "review" || from === "blocked") && isOpenWork(t);
    const byCreatorOrOwner = actor.kind === "user" || isBot(actor, creator);
    // A re-assign in the same update is woken by the board's assignment wake instead.
    if (
      sentBack &&
      byCreatorOrOwner &&
      assignee &&
      !isBot(actor, assignee) &&
      !change.assigneeChanged
    ) {
      const text = sentBackWakeText(t, await lastComment(ctx, t));
      await wakeForTicket(ctx, t, assignee, false, actor, { text, dedupeKey });
    }
  } catch (err) {
    ctx.deps.log?.error({ error: errText(err), ticketId: t.id }, "hub.ticket_followup_failed");
  }
}

/**
 * Wake the creator of `t` in its direct conversation (the ticket scope, through `ticketId`). A creator gone
 * from config, out of the ticket's group, or without a direct conversation is logged and skipped.
 */
async function wakeCreator(
  ctx: HubContext,
  t: Ticket,
  botId: BotId,
  actor: Author,
  dedupeKey: string,
): Promise<void> {
  const { store, log } = ctx.deps;
  const bot = await store.bots.get(botId);
  const group = t.groupId ? await store.groups.get(t.groupId) : undefined;
  const gone = !bot || (t.groupId !== undefined && !group?.members.includes(botId));
  const conv = gone ? undefined : await store.conversations.direct(botId);
  if (!conv) {
    const reason = gone ? "gone or left the group" : "no direct conversation";
    log?.warn({ ticketId: t.id, botId, reason }, "hub.ticket_creator_gone");
    return;
  }
  const text =
    t.status === "review" ? reviewWakeText(t, await lastComment(ctx, t)) : blockedWakeText(t);
  await createRun(ctx, {
    botId,
    conversationId: conv.id,
    sender: actor,
    text,
    // A bot actor is the sender, so the rate and repeat caps apply to it.
    hop: actor.kind === "bot" ? 1 : 0,
    opts: { ticketId: t.id },
    dedupeKey,
  });
}
