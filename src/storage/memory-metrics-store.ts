import type { Database } from "bun:sqlite";

/* Read-only counts for `metrics:memory`. Every query returns channel + local day + count; never note or summary text.
   SQL lives here only. */

/** One count of a channel on a local day (`YYYY-MM-DD`). */
export interface ChannelDayCount {
  channel: string;
  day: string;
  n: number;
}

/** Same plus the audit action (`save`, `edit_delete`, `edit_replace`). */
export interface ChannelDayActionCount extends ChannelDayCount {
  action: string;
}

/** Tables `metrics:memory` reads (added by migrations 0011/0012 `memory_audit`, 0009 `thread_summaries`, 0010 `memory_promotions`). */
const REQUIRED_TABLES = ["memory_audit", "thread_summaries", "memory_promotions"];

/** Required tables absent from the db (a db older than the migrations); empty when all exist. Read-only. */
export function missingMemoryTables(db: Database): string[] {
  const have = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name),
  );
  return REQUIRED_TABLES.filter((t) => !have.has(t));
}

/** SQLite expression turning an epoch-ms column into a local `YYYY-MM-DD`. */
const dayOf = (col: string): string =>
  `strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch', 'localtime')`;

/** Memory writes of the teammate (`memory_audit`) since `sinceMs`, by channel, day and action. */
export function auditCounts(db: Database, sinceMs: number): ChannelDayActionCount[] {
  return db
    .query<ChannelDayActionCount, [number]>(
      `SELECT channel, ${dayOf("ts")} AS day, action, COUNT(*) AS n FROM memory_audit
       WHERE ts >= ? GROUP BY channel, day, action`,
    )
    .all(sinceMs);
}

/** Episodes written or refreshed (`thread_summaries.updated_at`) since `sinceMs`. A re-saved thread counts once (one row per thread). */
export function episodeCounts(db: Database, sinceMs: number): ChannelDayCount[] {
  return db
    .query<ChannelDayCount, [number]>(
      `SELECT channel, ${dayOf("updated_at")} AS day, COUNT(*) AS n FROM thread_summaries
       WHERE updated_at >= ? GROUP BY channel, day`,
    )
    .all(sinceMs);
}

/** Episodes dreaming consumed (`thread_summaries.promoted_at`) since `sinceMs`. */
export function promotedEpisodeCounts(db: Database, sinceMs: number): ChannelDayCount[] {
  return db
    .query<ChannelDayCount, [number]>(
      `SELECT channel, ${dayOf("promoted_at")} AS day, COUNT(*) AS n FROM thread_summaries
       WHERE promoted_at >= ? GROUP BY channel, day`,
    )
    .all(sinceMs);
}

/** Journal bullets dreaming consumed (`memory_promotions`) since `sinceMs`. */
export function promotedJournalCounts(db: Database, sinceMs: number): ChannelDayCount[] {
  return db
    .query<ChannelDayCount, [number]>(
      `SELECT channel, ${dayOf("promoted_at")} AS day, COUNT(*) AS n FROM memory_promotions
       WHERE promoted_at >= ? GROUP BY channel, day`,
    )
    .all(sinceMs);
}
