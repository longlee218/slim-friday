import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import { redactSecrets, secretsFrom } from "../safety/redact-secrets";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from "./ticket";

/** Why a request was refused. */
export type TicketErrorCode = "invalid" | "not_found" | "unknown_bot" | "not_member" | "conflict";

/** Success with a payload, or a short reason a bot can read. */
export type TicketResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: TicketErrorCode; error: string };

/** What a caller may change on a ticket. */
export interface TicketUpdateInput {
  id: string;
  title?: string;
  description?: string | null;
  priority?: TicketPriority;
  status?: TicketStatus;
  assigneeBotId?: BotId;
  /** Required when the ticket moves into `blocked`; refused for any other result status. */
  blockedReason?: string;
  /** The `updatedAt` the caller read; another value means the ticket changed since. */
  expectedUpdatedAt?: number;
  conversationId?: ConversationId;
}

/** Every status a caller may set. */
export const STATUSES: readonly TicketStatus[] = TICKET_STATUSES;
/** Every priority a caller may set. */
export const PRIORITIES: readonly TicketPriority[] = TICKET_PRIORITIES;
/** Longest title, in characters. */
export const TITLE_MAX = 200;
/** Longest description, in characters. */
export const DESCRIPTION_MAX = 20_000;
/** Longest comment, in characters. */
export const COMMENT_MAX = 10_000;
/** Tickets per list page. */
export const PAGE_SIZE = 50;
/** Longest blocked reason, in characters. */
export const BLOCKED_REASON_MAX = 500;

/** Refusal: a field is missing, too long or not allowed. */
export const INVALID = { ok: false, code: "invalid", error: "Invalid ticket." } as const;
/** Refusal: the named bot does not exist. */
export const UNKNOWN_BOT = { ok: false, code: "unknown_bot", error: "Unknown bot." } as const;
/** Code of the refusal: the bot is not a member of the ticket's group. */
export const NOT_MEMBER_CODE = "not_member" as const;
/** Refusal: no such ticket. */
export const NOT_FOUND = { ok: false, code: "not_found", error: "Ticket not found." } as const;
/** Refusal: the ticket changed after the caller read it. */
export const CONFLICT = {
  ok: false,
  code: "conflict",
  error: "Ticket changed since you read it.",
} as const;
/** Refusal: moving into `blocked` needs a reason. */
export const REASON_REQUIRED = {
  ok: false,
  code: "invalid",
  error: "blockedReason is required when status is blocked.",
} as const;
/** Refusal: the status is not one of the known ones. */
export const BAD_STATUS = {
  ok: false,
  code: "invalid",
  error: `status must be one of ${STATUSES.join(", ")}.`,
} as const;

/** A finished ticket is never woken. */
export const finished = (s: TicketStatus) => s === "done" || s === "closed";

/** Ticket text with secrets redacted (bots write titles, descriptions and comments). */
export const cleanText = (source: (() => string[]) | undefined, text: string): string =>
  redactSecrets(text, secretsFrom(source));
