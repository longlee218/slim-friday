import type { Store } from "@friday/core";
import { and, count, eq, gt, ne, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { conversationReads, messages } from "../schema/engine-tables";

/** How far the owner has read each conversation. */
export function readRepo(db: BunSQLiteDatabase): Store["reads"] {
  const position = (c: string) =>
    db
      .select({ id: conversationReads.messageId })
      .from(conversationReads)
      .where(eq(conversationReads.conversationId, c))
      .get()?.id ?? 0;
  return {
    async get(c) {
      return position(c);
    },
    async set(c, messageId) {
      // max(): a late or repeated call never moves the position back.
      db.insert(conversationReads)
        .values({ conversationId: c, messageId })
        .onConflictDoUpdate({
          target: conversationReads.conversationId,
          set: { messageId: sql`max(${conversationReads.messageId}, ${messageId})` },
        })
        .run();
    },
    async unread(c) {
      const row = db
        .select({ n: count() })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, c),
            gt(messages.id, position(c)),
            ne(messages.authorKind, "user"),
          ),
        )
        .get();
      return row?.n ?? 0;
    },
  };
}
