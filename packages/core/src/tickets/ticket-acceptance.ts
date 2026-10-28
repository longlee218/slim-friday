import type { Author } from "../domain/message";
import type { Ticket, TicketStatus } from "./ticket";
import { NOT_ALLOWED, type TicketResult } from "./ticket-board-rules";

/**
 * Refuses a bot that sets `done` or `closed` on a ticket it did not create.
 * The owner and the system are never refused.
 */
export function acceptanceRefusal(
  cur: Ticket,
  actor: Author,
  nextStatus?: TicketStatus,
): TicketResult<never> | undefined {
  if (actor.kind !== "bot" || (nextStatus !== "done" && nextStatus !== "closed")) return undefined;
  const by = cur.createdBy;
  return by.kind === "bot" && by.botId === actor.botId ? undefined : NOT_ALLOWED;
}
