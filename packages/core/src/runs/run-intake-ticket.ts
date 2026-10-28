import type { BotId } from "../domain/bot";
import type { Conversation } from "../domain/conversation";
import type { GroupId } from "../domain/group";
import type { HubContext } from "../hub/hub-context";
import { errText, type WakeOpts } from "../hub/hub-types";
import { postStored } from "../hub/post-stored";
import { ownerComment } from "../hub/ticket-owner-comment";
import type { Store } from "../ports/store";
import { type Ticket, ticketRef } from "../tickets/ticket";
import { extractTicketRefs } from "../tickets/ticket-context";
import { isWaiting } from "../tickets/ticket-dependencies";

/** One owner message for one addressed bot, as the ticket route sees it. */
export interface TicketIntake {
  botId: BotId;
  conv: Conversation;
  messageId: number;
  /** The text as typed: it becomes the comment body. */
  typed: string;
  hasFiles: boolean;
  opts: WakeOpts;
}

/**
 * The bot's ticket in the group a message is about: the first named ref among its open, non-waiting
 * tickets there; else its only such ticket; else none.
 */
async function pickTicket(
  store: Pick<Store, "tickets">,
  botId: BotId,
  groupId: GroupId,
  text: string,
): Promise<Ticket | undefined> {
  const open: Ticket[] = [];
  for (const t of await store.tickets.activeOfAssignee(botId, groupId))
    if (!(await isWaiting(store, t))) open.push(t);
  for (const ref of extractTicketRefs(text)) {
    const hit = open.find((t) => ticketRef(t.number) === ref);
    if (hit) return hit;
  }
  return open.length === 1 ? open[0] : undefined;
}

/** Was the comment `commentId` saved on ticket `ticketId`? Unknown (the check fails) counts as no. */
async function commentSaved(ctx: HubContext, ticketId: string, commentId: string) {
  try {
    return (await ctx.deps.store.tickets.comments(ticketId)).some((c) => c.id === commentId);
  } catch {
    return false;
  }
}

/**
 * An owner group message about a ticket of the addressed bot becomes an owner comment on it, which wakes
 * the bot in its ticket work, and the group gets one system line. True when handled: the chat session
 * then does not run. A message with files, a reply-quote or attachments, or with no single target
 * ticket, is not handled. Idempotent per message and bot: a replay saves, posts and wakes nothing new.
 */
export async function routeToTicket(ctx: HubContext, t: TicketIntake): Promise<boolean> {
  if (t.conv.kind !== "group" || t.hasFiles || t.opts.quote || t.opts.attachments) return false;
  const { store } = ctx.deps;
  const commentId = `owner-msg:${t.messageId}:${t.botId}`;
  let target: Ticket | undefined;
  try {
    target = await pickTicket(store, t.botId, t.conv.groupId, t.typed);
    if (!target) return false;
    const ref = ticketRef(target.number);
    const r = await ownerComment(ctx, ref, t.typed, {
      commentId,
      dedupeKey: `owner-ticket:${t.messageId}:${t.botId}`,
    });
    if (!r.ok) return false;
    // A replay posts nothing: the line went out with the first save.
    if (r.created) {
      const name = (await store.bots.get(t.botId))?.name ?? t.botId;
      await postStored(ctx.deps, {
        conversationId: t.conv.id,
        author: { kind: "system" },
        text: `Added to ${ref} as a comment; ${name} continues it in its ticket work.`,
        at: ctx.deps.clock.now(),
      });
    }
    return true;
  } catch (err) {
    ctx.deps.log?.error(
      { error: errText(err), botId: t.botId, ticketId: target?.id },
      "hub.ticket_route_failed",
    );
    // Saved already: the ticket has the message, so the chat session must not handle it too.
    // Not saved (or unknown): the chat session handles it, so the message is never lost.
    return target ? commentSaved(ctx, target.id, commentId) : false;
  }
}
