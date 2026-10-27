import type { BotId } from "../domain/bot";
import type { GroupId } from "../domain/group";
import type { Author } from "../domain/message";
import type { WakeRow } from "../domain/wake";

/** Thrown (by session open, workspace and MCP start code) for a failure the owner must fix, not a retry. */
export class SetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SetupError";
  }
}

/** A conversational wake is the owner talking to a bot (no ticket); its steering may merge into a running run. */
export function isConversational(w: Pick<WakeRow, "sender" | "ticketId">): boolean {
  return w.sender.kind === "user" && w.ticketId === undefined;
}

/** Ticket and schedule wakes (`background`) are background work; everything else is claimed first. */
export function priorityOf(_sender: Author, background: boolean): "interactive" | "background" {
  return background ? "background" : "interactive";
}

/** Marks a ticket scope key: `<botId>#ticket@<groupId>` (ids never contain `#` or `@`). */
const TICKET_MARK = "#ticket@";

/**
 * Session scope key; equals `sessionScope().key`: the bot id (direct), `<botId>@<groupId>` (group chat) or
 * `<botId>#ticket@<groupId>` (the bot's tickets of that group). Every key of a group ends in `@<groupId>`.
 */
export function scopeKeyOf(botId: BotId, groupId?: GroupId, kind?: "ticket"): string {
  if (groupId === undefined) return botId;
  return kind === "ticket" ? `${botId}${TICKET_MARK}${groupId}` : `${botId}@${groupId}`;
}

/** The group of a scope key (text after its last `@`); undefined for the direct scope. */
export function groupOfScopeKey(key: string): GroupId | undefined {
  const at = key.lastIndexOf("@");
  return at < 0 ? undefined : key.slice(at + 1);
}

/** The bot of a scope key (text before its first `#` or `@`). */
export function botOfScopeKey(key: string): BotId {
  return key.split(/[#@]/)[0] ?? key;
}

/** A ticket scope key: the session where a bot works its tickets of one group. */
export function isTicketScopeKey(key: string): boolean {
  return key.includes(TICKET_MARK);
}

/** Error codes of a dropped or unreachable network. */
const TRANSIENT_CODES = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND"];
/** HTTP statuses worth a retry: rate limit, server errors, provider overloaded (529). */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 529]);
/** Message texts of a transient failure (lower case; an HTTP code counts only after "error", "status", "http" or "with", e.g. "API Error: 529"). */
const TRANSIENT_TEXT =
  /econnreset|etimedout|enotfound|fetch failed|overloaded|(error|status|http|with)\W{0,3}(429|500|502|503|529)\b/;
/** Messages thrown by today's session open and workspace checks of the agent runtime. */
const SETUP_TEXT = /^workspace .* is inside the agent home|^session .* not found/i;

/**
 * Sorts a run failure: `transient` (retry with backoff), `setup` (owner must fix; counted separately),
 * `fatal` (give up now). Reads `code`, `status`/`statusCode` and the message text.
 */
export function classifyFailure(err: unknown): "transient" | "setup" | "fatal" {
  if (err instanceof SetupError) return "setup";
  const e = (typeof err === "object" && err !== null ? err : {}) as Record<string, unknown>;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (typeof e.code === "string" && TRANSIENT_CODES.includes(e.code)) return "transient";
  for (const s of [e.status, e.statusCode])
    if (typeof s === "number" && TRANSIENT_STATUSES.has(s)) return "transient";
  if (TRANSIENT_TEXT.test(message.toLowerCase())) return "transient";
  if (SETUP_TEXT.test(message)) return "setup";
  return "fatal";
}

/** Wait before retry number `n` (1-based): 2 s doubling, capped at 60 s. */
export function backoffMs(n: number): number {
  return Math.min(60_000, 2_000 * 2 ** (n - 1));
}

/** UTC calendar day of an epoch time, as YYYY-MM-DD (the spend table's day key). */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
