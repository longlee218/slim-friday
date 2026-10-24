import type { Store } from "@friday/core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { wakes } from "../schema/engine-tables";
import { fromRow, toColumns } from "./wake-repo";

/** Statuses that still hold a scope or wait in it. */
const ACTIVE = ["queued", "leased", "running", "waiting_input"];

/**
 * Rows a worker may take: a due queued row whose scope has no leased or running row, or a held row whose
 * lease expired or was taken by another boot (its worker is gone). `owner` is `<bootId>:<workerId>`.
 */
const claimable = (bootId: string, now: number) => sql`(
  (${wakes.status} = 'queued'
    AND (${wakes.wakeAt} IS NULL OR ${wakes.wakeAt} <= ${now})
    AND NOT EXISTS (
      SELECT 1 FROM wakes o
      WHERE o.scope_key = ${wakes.scopeKey} AND o.status IN ('leased', 'running')))
  OR (${wakes.status} IN ('leased', 'running')
    AND (${wakes.leaseExpiresAt} <= ${now}
      OR ${wakes.leaseOwner} IS NULL
      OR substr(${wakes.leaseOwner}, 1, length(${bootId}) + 1) != ${`${bootId}:`}))
)`;

/** The claim, lease, fence and scope queries of the run queue (the rest of `Store["wakes"]`). */
export function runClaim(
  db: BunSQLiteDatabase,
): Pick<Store["wakes"], "claimNext" | "transition" | "renew" | "activeInScope"> {
  return {
    async claimNext({ owner, bootId, now, leaseMs }) {
      // IMMEDIATE takes the write lock first, so two connections cannot pick the same row.
      return db.transaction(
        (tx) => {
          const row = tx
            .select()
            .from(wakes)
            .where(claimable(bootId, now))
            .orderBy(
              sql`CASE ${wakes.priority} WHEN 'interactive' THEN 0 ELSE 1 END`,
              asc(wakes.createdAt),
              asc(wakes.id),
            )
            .limit(1)
            .get();
          if (!row) return undefined;
          const claimed = tx
            .update(wakes)
            .set({
              status: "leased",
              leaseOwner: owner,
              leaseFence: row.leaseFence + 1,
              leaseExpiresAt: now + leaseMs,
            })
            .where(eq(wakes.id, row.id))
            .returning()
            .get();
          return fromRow(claimed);
        },
        { behavior: "immediate" },
      );
    },
    async transition(id, fence, from, patch) {
      const cols = toColumns(patch);
      // An empty patch still checks the guard; `set` needs one column, so repeat the fence.
      const set = Object.keys(cols).length ? cols : { leaseFence: fence };
      return (
        db
          .update(wakes)
          .set(set)
          .where(and(eq(wakes.id, id), eq(wakes.leaseFence, fence), inArray(wakes.status, from)))
          .returning({ id: wakes.id })
          .all().length === 1
      );
    },
    async renew(id, owner, fence, until) {
      return (
        db
          .update(wakes)
          .set({ leaseExpiresAt: until })
          .where(
            and(
              eq(wakes.id, id),
              eq(wakes.leaseOwner, owner),
              eq(wakes.leaseFence, fence),
              inArray(wakes.status, ["leased", "running"]),
            ),
          )
          .returning({ id: wakes.id })
          .all().length === 1
      );
    },
    async activeInScope(scopeKey) {
      return db
        .select()
        .from(wakes)
        .where(and(eq(wakes.scopeKey, scopeKey), inArray(wakes.status, ACTIVE)))
        .orderBy(asc(wakes.createdAt), asc(wakes.id))
        .all()
        .map(fromRow);
    },
  };
}
