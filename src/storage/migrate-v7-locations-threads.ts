import type { Database } from "bun:sqlite";
import { logEvent, logger } from "../observability/logger";
import { countOf, hasTable, KEPT_TABLES, schemaVersion } from "./migrate";

const log = logger.child({ module: "db-migrate" });

/** Tables whose `repo` column becomes `location` (the code-only "repo" concept is now a generic "location"). */
const RENAMED_TABLES = ["turns", "sessions", "proposals"] as const;

/**
 * Threads: one row per Discord thread the agent knows. `origin` = `bot` (created by the agent) | `adopted`
 * (an existing thread the agent took over). `workspace` is '' until the thread is routed.
 */
export const THREADS_DDL = `CREATE TABLE threads (
  thread_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  workspace TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL,
  placeholder TEXT,
  title TEXT,
  digest TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

/** Channel listing: the newest threads of a channel. */
export const THREADS_INDEX_DDL =
  "CREATE INDEX threads_channel_updated ON threads (channel_id, updated_at)";

/** Error text without nested "Error:" prefixes. */
const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Schema v7: rename `repo` to `location` on turns, sessions and proposals, and add `threads` (+ index).
 * ONE transaction: any throw (a clash with an existing table, a count mismatch) rolls everything back and the
 * db stays v6; `schema_version` is written last. No-op when the db is already v7. The caller snapshots a v6 db
 * first.
 */
export function migrateV7(db: Database): void {
  if (schemaVersion(db) >= 7) return;
  try {
    db.transaction(() => {
      const kept = KEPT_TABLES.filter((t) => hasTable(db, t));
      const before = kept.map((t) => countOf(db, t));
      for (const t of RENAMED_TABLES) db.exec(`ALTER TABLE ${t} RENAME COLUMN repo TO location`);
      // Plain CREATE (no IF NOT EXISTS): a pre-existing table of the same name is a clash, not data to trust.
      db.exec(THREADS_DDL);
      db.exec(THREADS_INDEX_DDL);
      kept.forEach((t, i) => {
        if (countOf(db, t) !== before[i])
          throw new Error(
            `v7 migration: row count of ${t} changed (${before[i]} -> ${countOf(db, t)})`,
          );
      });
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '7')").run();
    })();
  } catch (err) {
    log.error({ err: msgOf(err) }, "db.migrate.failed");
    throw new Error(`v7 migration failed, the db stays at v6: ${msgOf(err)}`);
  }
  logEvent(log, "db.migrated", { from: 6, to: 7, added: ["threads", "repo->location"] });
}
