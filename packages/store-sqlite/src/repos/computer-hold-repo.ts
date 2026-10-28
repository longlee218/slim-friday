import type { ComputerHold, Store } from "@friday/core";
import { and, eq, gt, ne } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { computerHolds } from "../schema/engine-tables";

/** Computer holds. Acquire is one IMMEDIATE transaction, so two processes cannot both win a row. */
export function computerHoldRepo(db: BunSQLiteDatabase): Store["computerHolds"] {
  return {
    async acquire(a) {
      const key = a.kind === "input" ? `input:${a.computer}` : `slot:${a.botId}`;
      return db.transaction(
        (tx) => {
          const old = tx.select().from(computerHolds).where(eq(computerHolds.key, key)).get();
          const live = old !== undefined && old.expiresAt > a.now;
          if (live && old.holder !== a.holder) return undefined;
          if (a.kind === "slot" && a.slotLimit !== undefined) {
            const others = tx
              .select({ key: computerHolds.key })
              .from(computerHolds)
              .where(
                and(
                  eq(computerHolds.kind, "slot"),
                  gt(computerHolds.expiresAt, a.now),
                  ne(computerHolds.key, key),
                ),
              )
              .all().length;
            if (others >= a.slotLimit) return undefined;
          }
          // The same live holder keeps its fence; a new or expired row takes the next one.
          const row = {
            key,
            kind: a.kind,
            computer: a.computer,
            botId: a.botId,
            holder: a.holder,
            fence: live ? old.fence : (old?.fence ?? 0) + 1,
            expiresAt: a.now + a.ttlMs,
          };
          tx.insert(computerHolds)
            .values(row)
            .onConflictDoUpdate({ target: computerHolds.key, set: row })
            .run();
          return toHold(row);
        },
        { behavior: "immediate" },
      );
    },
    async renew(a) {
      return (
        db
          .update(computerHolds)
          .set({ expiresAt: a.now + a.ttlMs })
          .where(
            and(
              eq(computerHolds.key, a.key),
              eq(computerHolds.holder, a.holder),
              eq(computerHolds.fence, a.fence),
            ),
          )
          .returning({ key: computerHolds.key })
          .all().length === 1
      );
    },
    async release(a) {
      // Expire the row instead of deleting it, so the next takeover continues the fence.
      db.update(computerHolds)
        .set({ expiresAt: 0 })
        .where(
          and(
            eq(computerHolds.key, a.key),
            eq(computerHolds.holder, a.holder),
            eq(computerHolds.fence, a.fence),
          ),
        )
        .run();
    },
    async live(now) {
      return db
        .select()
        .from(computerHolds)
        .where(gt(computerHolds.expiresAt, now))
        .all()
        .map(toHold);
    },
  };
}

/** A table row as a domain hold. */
function toHold(r: typeof computerHolds.$inferSelect): ComputerHold {
  return { ...r, kind: r.kind as ComputerHold["kind"] };
}
