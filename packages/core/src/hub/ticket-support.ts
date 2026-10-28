import type { Store } from "../ports/store";
import { type Ticket, ticketRef } from "../tickets/ticket";
import { extractTicketRefs, renderTicketContext } from "../tickets/ticket-context";

/** The text a bot wakes on when a ticket is assigned to it (R§20, Friday's tool names). */
export const ticketWakeText = (t: Ticket): string =>
  `Work on ticket ${ticketRef(t.number)}. Read it with TicketGet. Keep progress in ticket comments and update its status with TicketUpdate. Use ask or approval cards when owner input is needed.`;

/** The text of the one extra wake for a ticket left open after a turn. */
export const ticketRewakeText = (t: Ticket): string =>
  `Your ticket ${ticketRef(t.number)} is still open. Finish it, or set it to blocked and comment why.`;

/** The longest last comment quoted in a follow-up wake. */
const LAST_COMMENT_MAX = 1_000;

/** A ticket's last comment for a wake text, clamped; `(no comment)` when there is none. */
const quote = (c: string | undefined): string =>
  c ? c.slice(0, LAST_COMMENT_MAX) : "(no comment)";

/** The text the creator wakes on when the assignee sets its ticket to review. */
export const reviewWakeText = (t: Ticket, lastComment?: string): string =>
  `Ticket ${ticketRef(t.number)} is ready for your review. Check it against its Done when. Set done, or send it back: comment what is missing and set it to todo.\nLast comment: ${quote(lastComment)}`;

/** The text the creator wakes on when its ticket is blocked. */
export const blockedWakeText = (t: Ticket): string =>
  `Ticket ${ticketRef(t.number)} is blocked: ${t.blockedReason ?? "no reason given"}. Unblock it (answer, re-assign, or ask the owner), or close it.`;

/** The text the assignee wakes on when the creator or owner sends its ticket back. */
export const sentBackWakeText = (t: Ticket, lastComment?: string): string =>
  `Ticket ${ticketRef(t.number)} was sent back to you: ${quote(lastComment)}. Fix it and set it to review.`;

/** The text the assignee wakes on when the owner comments on its ticket. */
export const ownerCommentWakeText = (t: Ticket, body: string): string =>
  `The owner commented on your ticket ${ticketRef(t.number)}: ${body.slice(0, LAST_COMMENT_MAX)}. Act on it, reply with a ticket comment, and update its status.`;

/** Comment left on a ticket that stays open after its re-wake. */
export const AUTO_BLOCK_COMMENT = "Left open after two turns; blocked automatically.";

/** A ticket still being worked on (the statuses an assignee must move on from). */
export const isOpenWork = (t: Ticket): boolean => t.status === "todo" || t.status === "doing";

/** The `<tickets_referenced>` block for the tickets a wake's text names; none when it names none. */
export async function ticketContextFor(
  store: Pick<Store, "tickets" | "bots">,
  text: string,
): Promise<string | undefined> {
  const entries = [];
  for (const ref of extractTicketRefs(text)) {
    const t = await store.tickets.getByNumber(Number(ref.split("-")[1]));
    if (!t) continue;
    const comments = await store.tickets.comments(t.id);
    const assignee = t.assigneeBotId ? await store.bots.get(t.assigneeBotId) : undefined;
    entries.push({
      ref,
      title: t.title,
      status: t.status,
      assignee: assignee?.name ?? t.assigneeBotId ?? null,
      lastComment: comments.at(-1)?.body ?? null,
    });
  }
  return renderTicketContext(entries);
}
