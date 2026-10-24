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

export const STATUSES: readonly TicketStatus[] = TICKET_STATUSES;
export const PRIORITIES: readonly TicketPriority[] = TICKET_PRIORITIES;
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 20_000;
export const COMMENT_MAX = 10_000;
export const PAGE_SIZE = 50;
export const BLOCKED_REASON_MAX = 500;

export const INVALID = { ok: false, code: "invalid", error: "Invalid ticket." } as const;
export const UNKNOWN_BOT = { ok: false, code: "unknown_bot", error: "Unknown bot." } as const;
export const NOT_FOUND = { ok: false, code: "not_found", error: "Ticket not found." } as const;
export const CONFLICT = {
  ok: false,
  code: "conflict",
  error: "Ticket changed since you read it.",
} as const;
export const reasonRequired = {
  ok: false,
  code: "invalid",
  error: "blockedReason is required when status is blocked.",
} as const;
export const BAD_STATUS = {
  ok: false,
  code: "invalid",
  error: `status must be one of ${STATUSES.join(", ")}.`,
} as const;

/** A finished ticket is never woken. */
export const finished = (s: TicketStatus) => s === "done" || s === "closed";
