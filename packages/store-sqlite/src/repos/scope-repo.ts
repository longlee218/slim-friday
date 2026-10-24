import type { Store } from "@friday/core";
import { eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { scopes } from "../schema/engine-tables";

/** Per-scope state: effort, pending reset, last finish and last flush. */
export function scopeRepo(db: BunSQLiteDatabase): Store["scopes"] {
  /** Create the row if missing, else apply `set` to it. */
  const upsert = (key: string, set: Partial<typeof scopes.$inferInsert>) =>
    db
      .insert(scopes)
      .values({ key, ...set })
      .onConflictDoUpdate({ target: scopes.key, set })
      .run();
  return {
    async get(key) {
      const r = db.select().from(scopes).where(eq(scopes.key, key)).get();
      if (!r) return undefined;
      return {
        ...(r.effort !== null && { effort: r.effort }),
        resetPending: r.resetPending === 1,
        ...(r.lastFinishedAt !== null && { lastFinishedAt: r.lastFinishedAt }),
        ...(r.lastFlushedAt !== null && { lastFlushedAt: r.lastFlushedAt }),
      };
    },
    async setEffort(key, effort) {
      upsert(key, { effort });
    },
    async markReset(key) {
      upsert(key, { resetPending: 1 });
    },
    async clearReset(key) {
      upsert(key, { resetPending: 0 });
    },
    async clearEffort(key) {
      upsert(key, { effort: null });
    },
    async finished(key, at, startedAt) {
      // A scope never flushed counts as flushed when this run started.
      db.insert(scopes)
        .values({ key, lastFinishedAt: at, lastFlushedAt: startedAt })
        .onConflictDoUpdate({
          target: scopes.key,
          set: {
            lastFinishedAt: at,
            lastFlushedAt: sql`coalesce(${scopes.lastFlushedAt}, ${startedAt})`,
          },
        })
        .run();
    },
    async flushed(key, at) {
      upsert(key, { lastFlushedAt: at });
    },
    async quiet(before) {
      // NULL finish never matches; a NULL flush counts as "not flushed". The AND keeps scopes whose last flush is not after their last finish.
      return db
        .select({ key: scopes.key })
        .from(scopes)
        .where(
          sql`${scopes.lastFinishedAt} < ${before}
            AND (${scopes.lastFlushedAt} IS NULL OR ${scopes.lastFlushedAt} < ${scopes.lastFinishedAt})`,
        )
        .all()
        .map((r) => r.key);
    },
  };
}
