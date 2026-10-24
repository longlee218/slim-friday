import type { BotId } from "../domain/bot";
import type { Author } from "../domain/message";

/** Where a ticket is in its life. `done` and `closed` are finished. */
export type TicketStatus = "todo" | "doing" | "review" | "blocked" | "done" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";

/** One task on the shared board. */
export interface Ticket {
  id: string;
  /** Counts up from 1 over the whole board; never reused. */
  number: number;
  title: string;
  description?: string;
  status: TicketStatus;
  priority: TicketPriority;
  /** The bot that owns the work; it is woken when it is assigned. */
  assigneeBotId?: BotId;
  createdBy: Author;
  createdAt: number;
  updatedAt: number;
  /** Set while the ticket is `done` or `closed`. */
  completedAt?: number;
}

/** A note on a ticket (progress, a question, a result). */
export interface TicketComment {
  id: string;
  ticketId: string;
  author: Author;
  body: string;
  createdAt: number;
}
