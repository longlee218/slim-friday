import type { Author, Store, Ticket, TicketComment } from "@friday/core";
import { and, asc, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { ticketComments, ticketCounter, tickets } from "../schema/engine-tables";

type Row = typeof tickets.$inferSelect;

/** Statuses whose tickets count as finished. */
const FINISHED = ["done", "closed"];

const toAuthor = (kind: string, botId: string | null): Author =>
  kind === "bot" && botId
    ? { kind: "bot", botId }
    : { kind: kind === "system" ? "system" : "user" };

const fromRow = (r: Row): Ticket => ({
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
});

/** The ticket board: tickets, their comments and the number counter. */
export function ticketRepo(db: BunSQLiteDatabase): Store["tickets"] {
  const byId = (id: string) => db.select().from(tickets).where(eq(tickets.id, id)).get();
  return {
    async create(t) {
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
            createdAt: t.createdAt,
            updatedAt: t.createdAt,
            completedAt: FINISHED.includes(t.status) ? t.createdAt : null,
          })
          .run();
        return fromRow(tx.select().from(tickets).where(eq(tickets.id, id)).get() as Row);
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
    async update(id, patch, now) {
      const cur = byId(id);
      if (!cur) return undefined;
      const status = patch.status ?? cur.status;
      db.update(tickets)
        .set({
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.priority !== undefined && { priority: patch.priority }),
          ...(patch.assigneeBotId !== undefined && { assigneeBotId: patch.assigneeBotId }),
          status,
          updatedAt: now,
          completedAt: FINISHED.includes(status) ? (cur.completedAt ?? now) : null,
        })
        .where(eq(tickets.id, id))
        .run();
      return fromRow(byId(id) as Row);
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
          .set({ updatedAt: sql`max(${tickets.updatedAt}, ${c.createdAt})` })
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
  };
}
