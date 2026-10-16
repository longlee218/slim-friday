import type { Database } from "bun:sqlite";
import { logEvent, logger } from "../observability/logger";
import { countOf, hasTable, KEPT_TABLES, schemaVersion } from "./migrate";

const log = logger.child({ module: "db-migrate" });

/**
 * Owned tasks: one row per piece of background work with ONE owner role (`owner_role` is always a background
 * role). `version` is the compare-and-set counter; `correlation_id` = trace id of the message that opened it.
 */
const OWNED_TASKS_DDL = `CREATE TABLE owned_tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  owner_role TEXT,
  status TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_progress_at INTEGER NOT NULL
)`;

/** Focus lookup: the newest open task of a thread. */
const OWNED_TASKS_INDEX_DDL =
  "CREATE INDEX owned_tasks_thread_progress ON owned_tasks (thread_id, last_progress_at)";

/** Link from a turn to the owned task it works on (null for foreground and side-lane turns). */
const TURNS_OWNED_TASK_DDL = "ALTER TABLE turns ADD COLUMN owned_task_id TEXT";

/** Error text without nested "Error:" prefixes. */
const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Schema v6: add `owned_tasks` (+ index) and `turns.owned_task_id`. Purely additive. ONE transaction: any throw
 * (a clash with an existing table/column, a count mismatch) rolls everything back and the db stays v5;
 * `schema_version` is written last. No-op when the db is already v6. The caller snapshots a v5 db first.
 */
export function migrateV6(db: Database): void {
  if (schemaVersion(db) >= 6) return;
  try {
    db.transaction(() => {
      const kept = KEPT_TABLES.filter((t) => hasTable(db, t));
      const before = kept.map((t) => countOf(db, t));
      // Plain CREATE (no IF NOT EXISTS): a pre-existing table of the same name is a clash, not data to trust.
      db.exec(OWNED_TASKS_DDL);
      db.exec(OWNED_TASKS_INDEX_DDL);
      db.exec(TURNS_OWNED_TASK_DDL);
      kept.forEach((t, i) => {
        if (countOf(db, t) !== before[i])
          throw new Error(
            `v6 migration: row count of ${t} changed (${before[i]} -> ${countOf(db, t)})`,
          );
      });
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '6')").run();
    })();
  } catch (err) {
    log.error({ err: msgOf(err) }, "db.migrate.failed");
    throw new Error(`v6 migration failed, the db stays at v5: ${msgOf(err)}`);
  }
  logEvent(log, "db.migrated", { from: 5, to: 6, added: ["owned_tasks", "turns.owned_task_id"] });
}
