import type { Author, Ticket } from "@friday/core";
import type { tickets } from "../schema/engine-tables";

/** A `tickets` table row. */
export type Row = typeof tickets.$inferSelect;

/** The author of a row; an unknown kind reads as the owner. */
export const toAuthor = (kind: string, botId: string | null): Author =>
  kind === "bot" && botId
    ? { kind: "bot", botId }
    : { kind: kind === "system" ? "system" : "user" };

/** A stored row as a `Ticket`; an empty `blocked_by` reads as absent. */
export const fromRow = (r: Row): Ticket => ({
  id: r.id,
  number: r.number,
  title: r.title,
  ...(r.description != null && { description: r.description }),
  status: r.status as Ticket["status"],
  priority: r.priority as Ticket["priority"],
  ...(r.assigneeBotId && { assigneeBotId: r.assigneeBotId }),
  createdBy: toAuthor(r.createdByKind, r.createdByBotId),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  ...(r.completedAt != null && { completedAt: r.completedAt }),
  ...(r.conversationId && { conversationId: r.conversationId }),
  ...(r.groupId && { groupId: r.groupId }),
  ...(r.blockedReason && { blockedReason: r.blockedReason }),
  ...(r.blockedBy && { blockedBy: JSON.parse(r.blockedBy) as string[] }),
});
