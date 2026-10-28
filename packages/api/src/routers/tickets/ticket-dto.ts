import type { TicketDto, TicketTimelineItemDto } from "@friday/contracts";
import { finished, type Store, type Ticket, type TimelineItem, ticketRef } from "@friday/core";

/** Blocker tickets by id, for mapping `blockedBy` ids to refs and finding what is still open. */
export type BlockerMap = Map<string, Ticket>;

/** Load every ticket the given tickets wait on, once each. */
export async function loadBlockers(
  store: Pick<Store, "tickets">,
  ts: Ticket[],
): Promise<BlockerMap> {
  const ids = [...new Set(ts.flatMap((t) => t.blockedBy ?? []))];
  const found = await Promise.all(ids.map((id) => store.tickets.get(id)));
  return new Map(found.flatMap((b) => (b ? [[b.id, b] as const] : [])));
}

/** A ticket as the web app sees it; explicit fields so nothing engine-only leaks. */
export function toTicketDto(
  t: Ticket,
  commentCount: number,
  blockers: BlockerMap = new Map(),
): TicketDto {
  const waiting = (t.blockedBy ?? []).flatMap((id) => {
    const b = blockers.get(id);
    return b ? [b] : [];
  });
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
    ...(waiting.length > 0 && { blockedBy: waiting.map((b) => ticketRef(b.number)) }),
    ...(waiting.some((b) => !finished(b.status)) && {
      waitingOn: waiting.filter((b) => !finished(b.status)).map((b) => ticketRef(b.number)),
    }),
    commentCount,
  };
}

/** One ticket as a DTO, counting its comments from the store. */
export async function ticketDtoFor(store: Pick<Store, "tickets">, t: Ticket): Promise<TicketDto> {
  const counts = await store.tickets.commentCounts([t.id]);
  return toTicketDto(t, counts.get(t.id) ?? 0, await loadBlockers(store, [t]));
}

/** Several tickets as DTOs with one comment-count query, keeping the order. */
export async function ticketDtosFor(
  store: Pick<Store, "tickets">,
  ts: Ticket[],
): Promise<TicketDto[]> {
  const counts = ts.length ? await store.tickets.commentCounts(ts.map((t) => t.id)) : new Map();
  const blockers = await loadBlockers(store, ts);
  return ts.map((t) => toTicketDto(t, counts.get(t.id) ?? 0, blockers));
}

/** The merged timeline as DTOs, in the same order. */
export function toTimelineDto(items: TimelineItem[]): TicketTimelineItemDto[] {
  return items.map((i) =>
    i.kind === "comment"
      ? { type: "comment", comment: i.comment }
      : { type: "event", event: i.event },
  );
}
