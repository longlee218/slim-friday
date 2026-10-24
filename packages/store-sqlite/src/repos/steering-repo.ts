import type { SteeringRow, Store } from "@friday/core";
import { and, asc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { steering, wakes } from "../schema/engine-tables";

type Row = typeof steering.$inferSelect;

/** Statuses of a run that takes no more steering rows: ended, or parked on a card. */
const ENDED = [
  "done",
  "failed",
  "interrupted",
  "cancelled",
  "blocked",
  "dropped",
  "expired",
  "waiting_input",
];

/** Owner messages sent while a run was busy: held, bound to a wake, claimed by its turn. */
export function steeringRepo(db: BunSQLiteDatabase): Store["steering"] {
  return {
    async add(r) {
      db.insert(steering)
        .values({
          id: r.id,
          messageId: r.messageId,
          conversationId: r.conversationId,
          scopeKey: r.scopeKey,
          wakeId: r.wakeId ?? null,
          text: r.text,
          attachments: r.attachments ? JSON.stringify(r.attachments) : null,
          createdAt: r.createdAt,
          claimedAt: r.claimedAt ?? null,
        })
        // Ids are deterministic per message and target, so a replayed intake adds nothing twice.
        .onConflictDoNothing({ target: steering.id })
        .run();
    },
    async claim(wakeId, at) {
      // IMMEDIATE: select and mark in one write lock, so a row is claimed by one caller only.
      return db.transaction(
        (tx) => {
          const mine = and(eq(steering.wakeId, wakeId), isNull(steering.claimedAt));
          const rows = tx
            .select()
            .from(steering)
            .where(mine)
            .orderBy(asc(steering.createdAt), asc(steering.id))
            .all();
          if (rows.length) {
            tx.update(steering)
              .set({ claimedAt: at })
              .where(
                inArray(
                  steering.id,
                  rows.map((r) => r.id),
                ),
              )
              .run();
          }
          return rows.map((r) => fromRow({ ...r, claimedAt: at }));
        },
        { behavior: "immediate" },
      );
    },
    async bound(wakeId) {
      return db
        .select()
        .from(steering)
        .where(and(eq(steering.wakeId, wakeId), isNull(steering.claimedAt)))
        .orderBy(asc(steering.createdAt), asc(steering.id))
        .all()
        .map(fromRow);
    },
    async remove(ids) {
      if (ids.length) db.delete(steering).where(inArray(steering.id, ids)).run();
    },
    async held(scopeKey) {
      return db
        .select()
        .from(steering)
        .where(and(eq(steering.scopeKey, scopeKey), isNull(steering.wakeId)))
        .orderBy(asc(steering.createdAt), asc(steering.id))
        .all()
        .map(fromRow);
    },
    async bind(ids, wakeId) {
      if (!ids.length) return [];
      // Only held, unclaimed rows bind; the rows actually changed come back.
      return db
        .update(steering)
        .set({ wakeId })
        .where(and(inArray(steering.id, ids), isNull(steering.wakeId), isNull(steering.claimedAt)))
        .returning({ id: steering.id })
        .all()
        .map((r) => r.id);
    },
    async deleteClaimed(wakeId) {
      db.delete(steering)
        .where(and(eq(steering.wakeId, wakeId), isNotNull(steering.claimedAt)))
        .run();
    },
    async unbind(wakeId) {
      db.update(steering)
        .set({ wakeId: null })
        .where(and(eq(steering.wakeId, wakeId), isNull(steering.claimedAt)))
        .run();
    },
    async releaseClaimed(wakeId) {
      db.update(steering)
        .set({ claimedAt: null })
        .where(and(eq(steering.wakeId, wakeId), isNotNull(steering.claimedAt)))
        .run();
    },
    async deleteForScope(scopeKey) {
      db.delete(steering).where(eq(steering.scopeKey, scopeKey)).run();
    },
    async endedRuns(limit, after) {
      return db
        .selectDistinct({ id: steering.wakeId })
        .from(steering)
        .innerJoin(wakes, eq(wakes.id, steering.wakeId))
        .where(and(inArray(wakes.status, ENDED), after ? gt(steering.wakeId, after) : undefined))
        .orderBy(asc(steering.wakeId))
        .limit(limit)
        .all()
        .flatMap((r) => (r.id ? [r.id] : []));
    },
    async heldScopes(limit, after) {
      return db
        .selectDistinct({ key: steering.scopeKey })
        .from(steering)
        .where(and(isNull(steering.wakeId), after ? gt(steering.scopeKey, after) : undefined))
        .orderBy(asc(steering.scopeKey))
        .limit(limit)
        .all()
        .map((r) => r.key);
    },
  };
}

/** A row as a domain value; null columns become absent fields. */
function fromRow(r: Row): SteeringRow {
  return {
    id: r.id,
    messageId: r.messageId,
    conversationId: r.conversationId,
    scopeKey: r.scopeKey,
    ...(r.wakeId !== null && { wakeId: r.wakeId }),
    text: r.text,
    ...(r.attachments && { attachments: JSON.parse(r.attachments) }),
    createdAt: r.createdAt,
    ...(r.claimedAt !== null && { claimedAt: r.claimedAt }),
  };
}
