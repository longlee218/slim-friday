import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Author } from "../domain/message";

/** Every status, in life order. */
export const TICKET_STATUSES = ["todo", "doing", "review", "blocked", "done", "closed"] as const;
/** Every priority, lowest first. */
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

/** Where a ticket is in its life. `done` and `closed` are finished. */
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

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
  /** The conversation the ticket was raised in. */
  conversationId?: ConversationId;
  /** Why the ticket is `blocked`; cleared when it leaves `blocked`. */
  blockedReason?: string;
}

/** What a history entry of a ticket records. */
export type TicketEventKind = "created" | "status" | "assignee" | "priority" | "handoff";

/** One change of a ticket; `from` / `to` are a status, a priority or a bot id. */
export interface TicketEvent {
  id: string;
  ticketId: string;
  kind: TicketEventKind;
  from?: string;
  to?: string;
  actor: Author;
  at: number;
}

/** A note on a ticket (progress, a question, a result). */
export interface TicketComment {
  id: string;
  ticketId: string;
  author: Author;
  body: string;
  createdAt: number;
}

/** Prefix of every ticket ref (`FRI-3`). */
export const TICKET_PREFIX = "FRI";

/** `FRI-<n>` for a ticket number. */
export const ticketRef = (n: number): string => `${TICKET_PREFIX}-${n}`;

/** The number in a ref like `fri-3` (any case); undefined for another prefix or a malformed ref. */
export function parseTicketRef(s: string): number | undefined {
  const m = new RegExp(`^${TICKET_PREFIX}-([1-9]\\d*)$`, "i").exec(s.trim());
  return m ? Number(m[1]) : undefined;
}
