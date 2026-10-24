import type { TicketDto, TicketTimelineItemDto } from "@friday/contracts";
import { type Store, type Ticket, type TimelineItem, ticketRef } from "@friday/core";

/** A ticket as the web app sees it; explicit fields so nothing engine-only leaks. */
export function toTicketDto(t: Ticket, commentCount: number): TicketDto {
  return {
    id: t.id,
    ref: ticketRef(t.number),
    number: t.number,
    title: t.title,
    ...(t.description !== undefined && { description: t.description }),
    status: t.status,
    priority: t.priority,
    ...(t.assigneeBotId && { assigneeBotId: t.assigneeBotId }),
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(t.completedAt !== undefined && { completedAt: t.completedAt }),
    ...(t.conversationId && { conversationId: t.conversationId }),
    ...(t.blockedReason && { blockedReason: t.blockedReason }),
    commentCount,
  };
}

/** One ticket as a DTO, counting its comments from the store. */
export async function ticketDtoFor(store: Pick<Store, "tickets">, t: Ticket): Promise<TicketDto> {
  const counts = await store.tickets.commentCounts([t.id]);
  return toTicketDto(t, counts.get(t.id) ?? 0);
}

/** Several tickets as DTOs with one comment-count query, keeping the order. */
export async function ticketDtosFor(
  store: Pick<Store, "tickets">,
  ts: Ticket[],
): Promise<TicketDto[]> {
  const counts = ts.length ? await store.tickets.commentCounts(ts.map((t) => t.id)) : new Map();
  return ts.map((t) => toTicketDto(t, counts.get(t.id) ?? 0));
}

/** The merged timeline as DTOs, in the same order. */
export function toTimelineDto(items: TimelineItem[]): TicketTimelineItemDto[] {
  return items.map((i) =>
    i.kind === "comment"
      ? { type: "comment", comment: i.comment }
      : { type: "event", event: i.event },
  );
}
