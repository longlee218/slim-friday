import type { ConversationId } from "../domain/conversation";
import type { Author } from "../domain/message";
import type { Clock } from "../ports/clock";
import type { Store } from "../ports/store";
import type { TicketComment } from "./ticket";
import {
  COMMENT_MAX,
  cleanText,
  INVALID,
  NOT_FOUND,
  type TicketResult,
} from "./ticket-board-rules";
import type { TicketReads } from "./ticket-reads";

/**
 * Save a comment on a ticket. A bot commenting from another conversation becomes the ticket's
 * "last worked" one. `saved` is the ticket after the write, for the board's change listeners.
 * With `commentId` a repeat saves nothing: it returns the stored comment, `created: false`, no `saved`.
 */
export async function addTicketComment(
  deps: {
    store: Pick<Store, "tickets">;
    clock: Clock;
    secretValues?: () => string[];
  },
  reads: TicketReads,
  actor: Author,
  i: { id: string; body: string; conversationId?: ConversationId; commentId?: string },
): Promise<
  TicketResult<{
    comment: TicketComment;
    created: boolean;
    saved?: Awaited<ReturnType<TicketReads["find"]>>;
  }>
> {
  const body = cleanText(deps.secretValues, i.body.trim());
  if (!body || body.length > COMMENT_MAX) return INVALID;
  const ticket = await reads.find(i.id);
  if (!ticket) return NOT_FOUND;
  const { store, clock } = deps;
  const row = { ticketId: ticket.id, author: actor, body, createdAt: clock.now() };
  const { comment, created } = i.commentId
    ? await store.tickets.addCommentOnce({ ...row, id: i.commentId })
    : { comment: await store.tickets.addComment(row), created: true };
  if (!created) return { ok: true, comment, created };
  if (actor.kind === "bot" && i.conversationId && i.conversationId !== ticket.conversationId)
    await store.tickets.update(ticket.id, { conversationId: i.conversationId }, clock.now());
  const saved = await store.tickets.get(ticket.id);
  return { ok: true, comment, created, ...(saved && { saved }) };
}
