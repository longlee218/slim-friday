import type { Store } from "@friday/core";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { spend } from "../schema/engine-tables";

/** Money spent per bot per day: `add` increments, it never replaces. */
export function spendRepo(db: BunSQLiteDatabase): Store["spend"] {
  return {
    async add(botId, day, usd) {
      db.insert(spend)
        .values({ botId, day, usd })
        .onConflictDoUpdate({
          target: [spend.botId, spend.day],
          set: { usd: sql`${spend.usd} + excluded.usd` },
        })
        .run();
    },
    async total(botId, day) {
      const r = db
        .select()
        .from(spend)
        .where(and(eq(spend.botId, botId), eq(spend.day, day)))
        .get();
      return r?.usd ?? 0;
    },
    async range(from, to) {
      // `YYYY-MM-DD` strings sort as dates, so a string range is a date range.
      return db
        .select()
        .from(spend)
        .where(and(gte(spend.day, from), lte(spend.day, to)))
        .orderBy(asc(spend.day), asc(spend.botId))
        .all()
        .map((r) => ({ botId: r.botId, day: r.day, usd: r.usd }));
    },
  };
}
