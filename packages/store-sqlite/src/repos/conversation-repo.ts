import type { Conversation, Store } from "@friday/core";
import { and, eq, notLike, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { conversations, messages } from "../schema/engine-tables";

/** Conversations: the port's `get` plus the adapter-only `put` (upsert). */
export function conversationRepo(
  db: BunSQLiteDatabase,
): Store["conversations"] & { put(c: Conversation): Promise<void> } {
  return {
    async get(id) {
      const r = db.select().from(conversations).where(eq(conversations.id, id)).get();
      if (!r) return undefined;
      return r.kind === "direct"
        ? { id: r.id, kind: "direct", botId: r.botId ?? "" }
        : { id: r.id, kind: "group", groupId: r.groupId ?? "" };
    },
    async direct(botId) {
      const r = db
        .select()
        .from(conversations)
        .where(and(eq(conversations.kind, "direct"), eq(conversations.botId, botId)))
        .get();
      return r ? { id: r.id, kind: "direct", botId } : undefined;
    },
    async list() {
      return db
        .select()
        .from(conversations)
        .all()
        .map((r) =>
          r.kind === "direct"
            ? { id: r.id, kind: "direct" as const, botId: r.botId ?? "" }
            : { id: r.id, kind: "group" as const, groupId: r.groupId ?? "" },
        );
    },
    async deleteLegacy() {
      // Ids that are neither `bot:*` nor `group:*` are chat-app channel ids of older builds.
      const legacy = and(notLike(conversations.id, "bot:%"), notLike(conversations.id, "group:%"));
      const ids = db.select({ id: conversations.id }).from(conversations).where(legacy).all();
      if (ids.length === 0) return 0;
      db.delete(messages)
        .where(
          sql`${messages.conversationId} IN (${sql.join(
            ids.map((i) => sql`${i.id}`),
            sql`, `,
          )})`,
        )
        .run();
      db.delete(conversations).where(legacy).run();
      return ids.length;
    },
    async put(c) {
      const row = {
        id: c.id,
        kind: c.kind,
        botId: c.kind === "direct" ? c.botId : null,
        groupId: c.kind === "group" ? c.groupId : null,
      };
      db.insert(conversations)
        .values(row)
        .onConflictDoUpdate({ target: conversations.id, set: row })
        .run();
    },
  };
}
