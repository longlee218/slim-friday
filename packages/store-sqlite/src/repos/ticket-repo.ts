import type { Store, TicketComment } from "@friday/core";
import { and, asc, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { ticketComments, ticketCounter, tickets } from "../schema/engine-tables";
import { insertTicketEvent } from "./ticket-event-repo";
import { ticketQueries } from "./ticket-repo-queries";
import { fromRow, type Row, toAuthor } from "./ticket-row";

/** Statuses whose tickets count as finished. */
const FINISHED = ["done", "closed"];

/** The ticket board: tickets, their comments and the number counter. */
export function ticketRepo(db: BunSQLiteDatabase): Store["tickets"] {
  const byId = (id: string) => db.select().from(tickets).where(eq(tickets.id, id)).get();
  return {
    ...ticketQueries(db),
    async create(t, opts) {
      // The counter is read and bumped in one transaction, so two creates never get the same number.
      return db.transaction((tx) => {
        const row = tx.select().from(ticketCounter).get();
        const number = (row?.last ?? 0) + 1;
        tx.insert(ticketCounter)
          .values({ id: 1, last: number })
          .onConflictDoUpdate({ target: ticketCounter.id, set: { last: number } })
          .run();
        const id = crypto.randomUUID();
        tx.insert(tickets)
          .values({
            id,
            number,
            title: t.title,
            description: t.description ?? null,
            status: t.status,
            priority: t.priority,
            assigneeBotId: t.assigneeBotId ?? null,
            createdByKind: t.createdBy.kind,
            createdByBotId: t.createdBy.kind === "bot" ? t.createdBy.botId : null,
            groupId: t.groupId ?? null,
            blockedBy: t.blockedBy?.length ? JSON.stringify(t.blockedBy) : null,
            createdAt: t.createdAt,
            updatedAt: t.createdAt,
            completedAt: FINISHED.includes(t.status) ? t.createdAt : null,
          })
          .run();
        const next = fromRow(tx.select().from(tickets).where(eq(tickets.id, id)).get() as Row);
        for (const e of opts?.events?.(next) ?? []) insertTicketEvent(tx, e);
        return next;
      });
    },
    async get(id) {
      const r = byId(id);
      return r && fromRow(r);
    },
    async getByNumber(n) {
      const r = db.select().from(tickets).where(eq(tickets.number, n)).get();
      return r && fromRow(r);
    },
    async openOfGroup(groupId) {
      return db
        .select()
        .from(tickets)
        .where(and(eq(tickets.groupId, groupId), inArray(tickets.status, ["todo", "doing"])))
        .orderBy(asc(tickets.createdAt), asc(tickets.id))
        .all()
        .map(fromRow);
    },
    async list(f) {
      const where = and(
        f.status ? eq(tickets.status, f.status) : undefined,
        f.excludeClosed ? ne(tickets.status, "closed") : undefined,
        f.assigneeBotId ? eq(tickets.assigneeBotId, f.assigneeBotId) : undefined,
        f.before
          ? or(
              lt(tickets.createdAt, f.before.createdAt),
              and(eq(tickets.createdAt, f.before.createdAt), lt(tickets.id, f.before.id)),
            )
          : undefined,
      );
      return db
        .select()
        .from(tickets)
        .where(where)
        .orderBy(desc(tickets.createdAt), desc(tickets.id))
        .limit(f.limit)
        .all()
        .map(fromRow);
    },
    async update(id, patch, now, opts) {
      // Read, compare and write in one transaction, so a stale `ifUpdatedAt` can never overwrite.
      return db.transaction((tx) => {
        const cur = tx.select().from(tickets).where(eq(tickets.id, id)).get();
        if (!cur) return undefined;
        const prev = fromRow(cur);
        if (opts?.ifUpdatedAt !== undefined && opts.ifUpdatedAt !== cur.updatedAt)
          return "conflict" as const;
        const status = patch.status ?? cur.status;
        // The reason lives only while blocked; a patch value wins over the stored one.
        const reason = patch.blockedReason === undefined ? cur.blockedReason : patch.blockedReason;
        tx.update(tickets)
          .set({
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.description !== undefined && { description: patch.description }),
            ...(patch.priority !== undefined && { priority: patch.priority }),
            ...(patch.assigneeBotId !== undefined && { assigneeBotId: patch.assigneeBotId }),
            ...(patch.conversationId !== undefined && { conversationId: patch.conversationId }),
            ...(patch.blockedBy !== undefined && {
              blockedBy: patch.blockedBy.length ? JSON.stringify(patch.blockedBy) : null,
            }),
            status,
            blockedReason: status === "blocked" ? reason : null,
            // Always moves forward, even for two writes in the same millisecond.
            updatedAt: Math.max(now, cur.updatedAt + 1),
            completedAt: FINISHED.includes(status) ? (cur.completedAt ?? now) : null,
          })
          .where(eq(tickets.id, id))
          .run();
        const next = fromRow(tx.select().from(tickets).where(eq(tickets.id, id)).get() as Row);
        // Same transaction as the change: both land or neither does.
        for (const e of opts?.events?.(prev, next) ?? []) insertTicketEvent(tx, e);
        return next;
      });
    },
    async addComment(c) {
      const id = crypto.randomUUID();
      db.transaction((tx) => {
        tx.insert(ticketComments)
          .values({
            id,
            ticketId: c.ticketId,
            authorKind: c.author.kind,
            authorBotId: c.author.kind === "bot" ? c.author.botId : null,
            body: c.body,
            createdAt: c.createdAt,
          })
          .run();
        tx.update(tickets)
          .set({ updatedAt: sql`max(${tickets.updatedAt} + 1, ${c.createdAt})` })
          .where(eq(tickets.id, c.ticketId))
          .run();
      });
      return { id, ...c };
    },
    async comments(ticketId) {
      return db
        .select()
        .from(ticketComments)
        .where(eq(ticketComments.ticketId, ticketId))
        .orderBy(asc(ticketComments.createdAt), asc(ticketComments.id))
        .all()
        .map(
          (r): TicketComment => ({
            id: r.id,
            ticketId: r.ticketId,
            author: toAuthor(r.authorKind, r.authorBotId),
            body: r.body,
            createdAt: r.createdAt,
          }),
        );
    },
    async commentCounts(ids) {
      const out = new Map<string, number>(ids.map((id) => [id, 0]));
      if (!ids.length) return out;
      const rows = db
        .select({ ticketId: ticketComments.ticketId, n: sql<number>`count(*)` })
        .from(ticketComments)
        .where(inArray(ticketComments.ticketId, ids))
        .groupBy(ticketComments.ticketId)
        .all();
      for (const r of rows) out.set(r.ticketId, r.n);
      return out;
    },
  };
}
