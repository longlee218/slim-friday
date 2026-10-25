import type { Store } from "@friday/core";
import { and, count, eq, gt, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { conversationReads, messages, wakes } from "../schema/engine-tables";

/** How far the owner has read each conversation. */
export function readRepo(db: BunSQLiteDatabase): Store["reads"] {
  const position = (c: string) =>
    db
      .select({ id: conversationReads.messageId })
      .from(conversationReads)
      .where(eq(conversationReads.conversationId, c))
      .get()?.id ?? 0;
  // Ids of the wakes whose messages never count as unread.
  const quietWakes = db
    .select({ id: wakes.id })
    .from(wakes)
    .where(
      and(
        isNull(wakes.cardId),
        or(eq(wakes.intro, true), isNotNull(wakes.ticketId), eq(wakes.senderKind, "bot")),
      ),
    );
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
            // Not for runs that do not talk to the owner: intro, ticket, bot-to-bot (same rule as core's
            // `talksToOwner`: a run resumed by a card answer is the owner's).
            or(isNull(messages.wakeId), notInArray(messages.wakeId, quietWakes)),
          ),
        )
        .get();
      return row?.n ?? 0;
    },
  };
}
