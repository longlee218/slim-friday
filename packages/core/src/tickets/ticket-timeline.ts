import { type Ticket, type TicketComment, type TicketEvent, ticketRef } from "./ticket";
import { extractTicketRefs } from "./ticket-context";

/** One entry of a ticket's timeline: a comment or a recorded change. */
export type TimelineItem =
  | { kind: "comment"; at: number; comment: TicketComment }
  | { kind: "event"; at: number; event: TicketEvent };

/**
 * Comments and events as one list by time, oldest first. Within one millisecond events come first;
 * otherwise each input keeps its own order (Array.sort is stable).
 */
export function mergeTimeline(comments: TicketComment[], events: TicketEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...events.map((event): TimelineItem => ({ kind: "event", at: event.at, event })),
    ...comments.map(
      (comment): TimelineItem => ({ kind: "comment", at: comment.createdAt, comment }),
    ),
  ];
  // Events were listed first, so a stable sort by time alone puts them before comments of the same ms.
  return items.sort((a, b) => a.at - b.at);
}

/** Refs named in the description and then each comment: unique, own ref removed, first-appearance order. */
export function relatedRefs(ticket: Ticket, comments: TicketComment[]): string[] {
  const own = ticketRef(ticket.number);
  const refs = new Set<string>();
  for (const text of [ticket.description ?? "", ...comments.map((c) => c.body)])
    for (const r of extractTicketRefs(text)) refs.add(r);
  refs.delete(own);
  return [...refs];
}
