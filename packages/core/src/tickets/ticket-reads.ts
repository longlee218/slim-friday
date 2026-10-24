import type { BotId } from "../domain/bot";
import type { Store } from "../ports/store";
import { parseTicketRef, type Ticket, type TicketComment, type TicketStatus } from "./ticket";
import { BAD_STATUS, PAGE_SIZE, STATUSES, type TicketResult } from "./ticket-board-rules";
import { decodeCursor, encodeCursor, shortDescription } from "./ticket-cursor";
import { mergeTimeline, relatedRefs, type TimelineItem } from "./ticket-timeline";

/** A ticket with everything the detail view needs. */
export interface TicketDetail {
  ticket: Ticket;
  timeline: TimelineItem[];
  related: Ticket[];
  commentCount: number;
}

/** The read side of the board: one ticket, its timeline, and pages of the list. */
export class TicketReads {
  constructor(private store: Pick<Store, "tickets" | "ticketEvents">) {}

  async get(ref: string): Promise<TicketResult<{ ticket: Ticket; comments: TicketComment[] }>> {
    const ticket = await this.find(ref);
    if (!ticket) return { ok: false, code: "not_found", error: `Ticket ${ref} not found.` };
    return { ok: true, ticket, comments: await this.store.tickets.comments(ticket.id) };
  }

  /** One ticket with its merged timeline, the tickets it names and its comment count. */
  async detail(ref: string): Promise<TicketResult<TicketDetail>> {
    const ticket = await this.find(ref);
    if (!ticket) return { ok: false, code: "not_found", error: `Ticket ${ref} not found.` };
    const { store } = this;
    const [comments, events] = await Promise.all([
      store.tickets.comments(ticket.id),
      store.ticketEvents.list(ticket.id),
    ]);
    const related: Ticket[] = [];
    for (const r of relatedRefs(ticket, comments)) {
      const t = await store.tickets.getByNumber(Number(r.split("-")[1]));
      if (t) related.push(t);
    }
    return {
      ok: true,
      ticket,
      timeline: mergeTimeline(comments, events),
      related,
      commentCount: comments.length,
    };
  }

  async list(i: {
    status?: TicketStatus;
    assigneeBotId?: BotId;
    cursor?: string;
  }): Promise<TicketResult<{ tickets: Ticket[]; nextCursor?: string }>> {
    if (i.status !== undefined && !STATUSES.includes(i.status)) return BAD_STATUS;
    let before: { createdAt: number; id: string } | undefined;
    if (i.cursor !== undefined) {
      before = decodeCursor(i.cursor);
      if (!before) return { ok: false, code: "invalid", error: "cursor is invalid." };
    }
    // One extra row tells whether another page follows.
    const rows = await this.store.tickets.list({
      ...(i.status ? { status: i.status } : { excludeClosed: true }),
      ...(i.assigneeBotId && { assigneeBotId: i.assigneeBotId }),
      ...(before && { before }),
      limit: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE).map(shortDescription);
    const last = page[page.length - 1];
    return {
      ok: true,
      tickets: page,
      ...(rows.length > PAGE_SIZE && last && { nextCursor: encodeCursor(last) }),
    };
  }

  /** A ticket by ref (`fri-3`, any case) or by id. A ref of another prefix is not a ticket. */
  async find(refOrId: string): Promise<Ticket | undefined> {
    const n = parseTicketRef(refOrId);
    if (n !== undefined) return this.store.tickets.getByNumber(n);
    if (/^[A-Za-z]+-\d+$/.test(refOrId.trim())) return undefined;
    return this.store.tickets.get(refOrId.trim());
  }
}
