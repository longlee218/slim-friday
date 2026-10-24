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

/** Ticket wakes are background work; everything else is claimed first. */
export function priorityOf(_sender: Author, ticketId?: string): "interactive" | "background" {
  return ticketId === undefined ? "interactive" : "background";
}

/** Session scope key: the bot id (direct) or `<botId>@<groupId>` (group); equals `sessionScope().key`. */
export function scopeKeyOf(botId: BotId, groupId?: GroupId): string {
  return groupId === undefined ? botId : `${botId}@${groupId}`;
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
