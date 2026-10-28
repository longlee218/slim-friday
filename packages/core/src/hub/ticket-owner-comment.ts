import { type Ticket, type TicketComment, ticketRef } from "../tickets/ticket";
import type { TicketResult } from "../tickets/ticket-board";
import { waitingOn } from "../tickets/ticket-dependencies";
import type { HubContext } from "./hub-context";
import { ownerCommentWakeText } from "./ticket-support";
import { wakeForTicket } from "./ticket-wakes";

const OWNER = { kind: "user" } as const;

/** Why an owner comment on `t` wakes nobody; undefined when the assignee should be woken. */
async function noWakeReason(ctx: HubContext, t: Ticket): Promise<string | undefined> {
  if (t.status === "done" || t.status === "closed")
    return "the ticket is finished. Reopen it to continue.";
  const waits = await waitingOn(ctx.deps.store, t);
  if (waits.length > 0)
    return `the ticket waits on ${waits.map((b) => ticketRef(b.number)).join(", ")}.`;
  if (!t.assigneeBotId) return "the ticket has no assignee.";
  return undefined;
}

/**
 * The owner comments on a ticket. A new comment wakes the assignee with the comment text, unless
 * the ticket is finished, waits on others or has no assignee: then `woke` is false and `note` says why.
 * A repeated `commentId` saves and wakes nothing.
 */
export async function ownerComment(
  ctx: HubContext,
  ref: string,
  body: string,
  opts: { commentId?: string; dedupeKey?: string } = {},
): Promise<
  TicketResult<{ comment: TicketComment; created: boolean; woke: boolean; note?: string }>
> {
  const r = await ctx.tickets.comment(OWNER, {
    id: ref,
    body,
    ...(opts.commentId && { commentId: opts.commentId }),
  });
  if (!r.ok) return r;
  const { comment, created } = r;
  const t = await ctx.deps.store.tickets.get(comment.ticketId);
  if (!t) return { ok: true, comment, created, woke: false };
  const why = await noWakeReason(ctx, t);
  if (why) return { ok: true, comment, created, woke: false, note: `No one was woken: ${why}` };
  // A repeated comment was woken the first time.
  if (created && t.assigneeBotId)
    await wakeForTicket(ctx, t, t.assigneeBotId, false, OWNER, {
      text: ownerCommentWakeText(t, comment.body),
      ...(opts.dedupeKey && { dedupeKey: opts.dedupeKey }),
    });
  return { ok: true, comment, created, woke: true };
}
