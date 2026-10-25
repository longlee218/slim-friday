import type { Author } from "../domain/message";
import type { Ticket, TicketEvent } from "./ticket";

/** A history entry before it gets an id. */
type NewTicketEvent = Omit<TicketEvent, "id">;

/** Give an entry a fresh id; the store writes it with the ticket change. */
const withId = (e: NewTicketEvent): TicketEvent => ({ id: crypto.randomUUID(), ...e });

/** The entry for a new ticket; `to` is the assignee when there is one. */
export const createdEvent = (t: Ticket, actor: Author, at: number): TicketEvent =>
  withId({
    ticketId: t.id,
    kind: "created",
    ...(t.assigneeBotId && { to: t.assigneeBotId }),
    actor,
    at,
  });

/**
 * One entry per changed field (status, priority, assignee). A bot that passes on a ticket it was
 * assigned records a `handoff`; any other assignee change is an `assignee` entry.
 */
export function ticketChangeEvents(
  cur: Ticket,
  next: Ticket,
  actor: Author,
  at: number,
): TicketEvent[] {
  const base = { ticketId: cur.id, actor, at };
  const out: NewTicketEvent[] = [];
  if (cur.status !== next.status)
    out.push({ ...base, kind: "status", from: cur.status, to: next.status });
  if (cur.priority !== next.priority)
    out.push({ ...base, kind: "priority", from: cur.priority, to: next.priority });
  if (cur.assigneeBotId !== next.assigneeBotId) {
    const handoff = actor.kind === "bot" && actor.botId === cur.assigneeBotId;
    out.push({
      ...base,
      kind: handoff ? "handoff" : "assignee",
      ...(cur.assigneeBotId && { from: cur.assigneeBotId }),
      ...(next.assigneeBotId && { to: next.assigneeBotId }),
    });
  }
  return out.map(withId);
}
