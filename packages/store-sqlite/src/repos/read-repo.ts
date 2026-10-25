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
  // Ids of the wakes whose messages never count as unread (core's `talksToOwner` is false): not resumed by a card,
  // never a schedule run, and an intro, a ticket, or a bot-sent run that is no relay (`result` / `status`) and no hand-off.
  const quietWakes = db
    .select({ id: wakes.id })
    .from(wakes)
    .where(
      and(
        isNull(wakes.cardId),
        // A schedule run talks to the owner whatever its sender, so it is never quiet.
        isNull(wakes.scheduleId),
        or(
          eq(wakes.intro, true),
          isNotNull(wakes.ticketId),
          and(
            eq(wakes.senderKind, "bot"),
            notInArray(wakes.intent, ["result", "status"]),
            or(isNull(wakes.handoff), eq(wakes.handoff, false)),
          ),
        ),
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
            // Not for runs that do not talk to the owner (same rule as core's `talksToOwner`).
            or(isNull(messages.wakeId), notInArray(messages.wakeId, quietWakes)),
          ),
        )
        .get();
      return row?.n ?? 0;
    },
  };
}
