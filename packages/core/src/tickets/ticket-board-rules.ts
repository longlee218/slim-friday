import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from "./ticket";

/** Why a request was refused. */
export type TicketErrorCode = "invalid" | "not_found" | "unknown_bot" | "conflict";

/** Success with a payload, or a short reason a bot can read. */
export type TicketResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: TicketErrorCode; error: string };

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
