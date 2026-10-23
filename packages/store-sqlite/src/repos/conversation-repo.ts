import type { Conversation, Store } from "@friday/core";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { conversations } from "../schema/engine-tables";

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
