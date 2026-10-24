import type { Ticket } from "./ticket";

/** Longest description in a list row (the full text comes with `get`). */
const LIST_DESCRIPTION_MAX = 200;

/** Description cut for a list row. */
export function shortDescription(t: Ticket): Ticket {
  if (!t.description || t.description.length <= LIST_DESCRIPTION_MAX) return t;
  return { ...t, description: `${t.description.slice(0, LIST_DESCRIPTION_MAX)}…` };
}

/** Position after a ticket; `createdAt` and `id` never change, so an edited or deleted ticket cannot break paging. */
export const encodeCursor = (t: Ticket): string =>
  Buffer.from(`${t.createdAt}|${t.id}`).toString("base64url");

/** The (createdAt, id) a cursor names; undefined for a malformed cursor. */
export function decodeCursor(c: string): { createdAt: number; id: string } | undefined {
  const [at, ...rest] = Buffer.from(c, "base64url").toString().split("|");
  const createdAt = Number(at);
  const id = rest.join("|");
  return Number.isFinite(createdAt) && at !== "" && id ? { createdAt, id } : undefined;
}
