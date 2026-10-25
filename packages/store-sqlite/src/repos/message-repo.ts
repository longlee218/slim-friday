import type { Author, IndexedMessage, Store, StoredMessage } from "@friday/core";
import { and, asc, count, desc, eq, gt, lt } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { messages } from "../schema/engine-tables";

type Row = typeof messages.$inferSelect;

/** Messages of every conversation. */
export function messageRepo(db: BunSQLiteDatabase): Store["messages"] {
  return {
    async append(m) {
      return db.insert(messages).values(toValues(m)).returning({ id: messages.id }).get().id;
    },
    async appendOnce(m, clientNonce) {
      // One INSERT decides who is first; a conflict on (conversation, nonce) means a replay.
      const row = db
        .insert(messages)
        .values({ ...toValues(m), clientNonce })
        .onConflictDoNothing({ target: [messages.conversationId, messages.clientNonce] })
        .returning({ id: messages.id })
        .get();
      if (row) return { id: row.id, replayed: false };
      const first = db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(eq(messages.conversationId, m.conversationId), eq(messages.clientNonce, clientNonce)),
        )
        .get();
      if (!first) throw new Error(`message with nonce ${clientNonce} vanished after a conflict`);
      return { id: first.id, replayed: true };
    },
    async byNonce(c, clientNonce) {
      return db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, c), eq(messages.clientNonce, clientNonce)))
        .get()?.id;
    },
    async get(id) {
      const r = db.select().from(messages).where(eq(messages.id, id)).get();
      return r && toIndexed(r);
    },
    async page(c, f) {
      const where =
        f.before !== undefined
          ? and(eq(messages.conversationId, c), lt(messages.id, f.before))
          : eq(messages.conversationId, c);
      return db
        .select()
        .from(messages)
        .where(where)
        .orderBy(desc(messages.id))
        .limit(f.limit)
        .all()
        .map(toIndexed);
    },
    async recent(c, limit) {
      const rows = db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, c))
        .orderBy(desc(messages.id))
        .limit(limit)
        .all();
      // Newest first from the query; the port wants the last N oldest first.
      return rows.reverse().map(toStored);
    },
    async countInterim(wakeId) {
      return (
        db
          .select({ n: count() })
          .from(messages)
          .where(and(eq(messages.wakeId, wakeId), eq(messages.kind, "progress")))
          .get()?.n ?? 0
      );
    },
    async after(afterId, limit) {
      return db
        .select()
        .from(messages)
        .where(gt(messages.id, afterId))
        .orderBy(asc(messages.id))
        .limit(limit)
        .all()
        .map(toIndexed);
    },
  };
}

/** Column values of a new message row. */
function toValues(m: StoredMessage) {
  return {
    conversationId: m.conversationId,
    authorKind: m.author.kind,
    authorBotId: m.author.kind === "bot" ? m.author.botId : null,
    text: m.text,
    at: m.at,
    kind: m.kind ?? "text",
    replyTo: m.replyTo ?? null,
    files: m.files ? JSON.stringify(m.files) : null,
    run: m.run ? JSON.stringify(m.run) : null,
    relay: m.relay ? JSON.stringify(m.relay) : null,
    wakeId: m.wakeId ?? null,
  };
}

/** A row with its id; `kind` is always set here (`recent` keeps the plain shape of older callers). */
function toIndexed(r: Row): IndexedMessage {
  return { id: r.id, ...toStored(r), kind: r.kind as StoredMessage["kind"] };
}

/** A row as a stored message; optional fields are left out when empty. */
function toStored(r: Row): StoredMessage {
  return {
    conversationId: r.conversationId,
    author: authorOf(r),
    text: r.text,
    at: r.at,
    ...(r.kind !== "text" && { kind: r.kind as StoredMessage["kind"] }),
    ...(r.replyTo !== null && { replyTo: r.replyTo }),
    ...(r.files && { files: JSON.parse(r.files) }),
    ...(r.run && { run: JSON.parse(r.run) }),
    ...(r.relay && { relay: JSON.parse(r.relay) }),
    ...(r.wakeId && { wakeId: r.wakeId }),
  };
}

/** The author of a stored row. */
function authorOf(r: { authorKind: string; authorBotId: string | null }): Author {
  if (r.authorKind === "bot") return { kind: "bot", botId: r.authorBotId ?? "" };
  return r.authorKind === "system" ? { kind: "system" } : { kind: "user" };
}
