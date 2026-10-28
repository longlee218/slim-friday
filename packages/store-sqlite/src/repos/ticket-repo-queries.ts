import type { Store } from "@friday/core";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { ticketComments, tickets } from "../schema/engine-tables";
import { fromRow, toAuthor } from "./ticket-row";

/** Queries of the ticket board beyond plain CRUD: comment-once, active work, dependents. */
export function ticketQueries(
  db: BunSQLiteDatabase,
): Pick<Store["tickets"], "addCommentOnce" | "activeOfAssignee" | "blockedByTicket"> {
  return {
    async addCommentOnce(c) {
      return db.transaction((tx) => {
        const res = tx
          .insert(ticketComments)
          .values({
            id: c.id,
            ticketId: c.ticketId,
            authorKind: c.author.kind,
            authorBotId: c.author.kind === "bot" ? c.author.botId : null,
            body: c.body,
            createdAt: c.createdAt,
          })
          .onConflictDoNothing()
          .returning({ id: ticketComments.id })
          .all();
        const created = res.length > 0;
        // A repeat leaves the ticket's `updatedAt` alone.
        if (created)
          tx.update(tickets)
            .set({ updatedAt: sql`max(${tickets.updatedAt} + 1, ${c.createdAt})` })
            .where(eq(tickets.id, c.ticketId))
            .run();
        const r = tx.select().from(ticketComments).where(eq(ticketComments.id, c.id)).get();
        if (!r) throw new Error(`comment ${c.id} missing after insert`);
        return {
          created,
          comment: {
            id: r.id,
            ticketId: r.ticketId,
            author: toAuthor(r.authorKind, r.authorBotId),
            body: r.body,
            createdAt: r.createdAt,
          },
        };
      });
    },
    async activeOfAssignee(botId, groupId) {
      return db
        .select()
        .from(tickets)
        .where(
          and(
            eq(tickets.assigneeBotId, botId),
            eq(tickets.groupId, groupId),
            notInArray(tickets.status, ["done", "closed"]),
          ),
        )
        .orderBy(asc(tickets.createdAt), asc(tickets.id))
        .all()
        .map(fromRow);
    },
    async blockedByTicket(id) {
      return db
        .select()
        .from(tickets)
        .where(sql`exists (select 1 from json_each(${tickets.blockedBy}) where value = ${id})`)
        .orderBy(asc(tickets.createdAt), asc(tickets.id))
        .all()
        .map(fromRow);
    },
  };
}
