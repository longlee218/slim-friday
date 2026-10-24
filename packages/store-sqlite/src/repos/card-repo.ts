import type { CardRow, Store } from "@friday/core";
import { and, asc, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { cards } from "../schema/engine-tables";

type Row = typeof cards.$inferSelect;

/** Approval and question cards; status changes are single guarded updates. */
export function cardRepo(db: BunSQLiteDatabase): Store["cards"] {
  const oldestFirst = [asc(cards.createdAt), asc(cards.id)];
  return {
    async insert(c) {
      db.insert(cards).values(toRow(c)).run();
    },
    async insertIfNoneOpen(group) {
      const wakeId = group[0]?.wakeId;
      if (wakeId === undefined) return false;
      // IMMEDIATE: the check and the insert hold one write lock, so a run never gets two open card groups.
      return db.transaction(
        (tx) => {
          const open = tx
            .select({ id: cards.id })
            .from(cards)
            .where(and(eq(cards.wakeId, wakeId), eq(cards.status, "open")))
            .get();
          if (open) return false;
          for (const c of group) tx.insert(cards).values(toRow(c)).run();
          return true;
        },
        { behavior: "immediate" },
      );
    },
    async get(id) {
      const r = db.select().from(cards).where(eq(cards.id, id)).get();
      return r && fromRow(r);
    },
    async open() {
      return db
        .select()
        .from(cards)
        .where(eq(cards.status, "open"))
        .orderBy(...oldestFirst)
        .all()
        .map(fromRow);
    },
    async openForScope(scopeKey) {
      return db
        .select()
        .from(cards)
        .where(and(eq(cards.scopeKey, scopeKey), eq(cards.status, "open")))
        .orderBy(...oldestFirst)
        .all()
        .map(fromRow);
    },
    async answer(id, answer, at, messageId) {
      // The WHERE makes "open -> answered" happen once even with two callers.
      return (
        db
          .update(cards)
          .set({
            status: "answered",
            answer: answer === undefined ? null : JSON.stringify(answer),
            answeredAt: at,
            answeredMessageId: messageId ?? null,
          })
          .where(and(eq(cards.id, id), eq(cards.status, "open")))
          .returning({ id: cards.id })
          .all().length === 1
      );
    },
    async forWake(wakeId) {
      return db
        .select()
        .from(cards)
        .where(eq(cards.wakeId, wakeId))
        .orderBy(...oldestFirst)
        .all()
        .map(fromRow);
    },
    async answeredByMessage(messageId) {
      return db
        .select()
        .from(cards)
        .where(eq(cards.answeredMessageId, messageId))
        .orderBy(...oldestFirst)
        .all()
        .map(fromRow);
    },
    async setStatus(id, from, to) {
      return (
        db
          .update(cards)
          .set({ status: to })
          .where(and(eq(cards.id, id), eq(cards.status, from)))
          .returning({ id: cards.id })
          .all().length === 1
      );
    },
    async markReminded(id, at) {
      db.update(cards).set({ remindedAt: at }).where(eq(cards.id, id)).run();
    },
  };
}

/** A domain card as a row; JSON fields as text, absent fields as null. */
function toRow(c: CardRow): typeof cards.$inferInsert {
  return {
    id: c.id,
    kind: c.kind,
    wakeId: c.wakeId,
    botId: c.botId,
    conversationId: c.conversationId,
    scopeKey: c.scopeKey,
    approval: c.approval ? JSON.stringify(c.approval) : null,
    question: c.question ? JSON.stringify(c.question) : null,
    status: c.status,
    answer: c.answer !== undefined ? JSON.stringify(c.answer) : null,
    createdAt: c.createdAt,
    answeredAt: c.answeredAt ?? null,
    remindedAt: c.remindedAt ?? null,
  };
}

/** A row as a domain value; null columns become absent fields. */
function fromRow(r: Row): CardRow {
  return {
    id: r.id,
    kind: r.kind as CardRow["kind"],
    wakeId: r.wakeId,
    botId: r.botId,
    conversationId: r.conversationId,
    scopeKey: r.scopeKey,
    ...(r.approval && { approval: JSON.parse(r.approval) }),
    ...(r.question && { question: JSON.parse(r.question) }),
    status: r.status as CardRow["status"],
    ...(r.answer !== null && { answer: JSON.parse(r.answer) }),
    createdAt: r.createdAt,
    ...(r.answeredAt !== null && { answeredAt: r.answeredAt }),
    ...(r.remindedAt !== null && { remindedAt: r.remindedAt }),
    ...(r.answeredMessageId !== null && { answeredMessageId: r.answeredMessageId }),
  };
}
