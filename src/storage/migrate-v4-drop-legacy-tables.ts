import type { Database } from "bun:sqlite";
import { logEvent, logger } from "../observability/logger";
import { hasTable, schemaVersion } from "./migrate";

const log = logger.child({ module: "db-migrate" });

/** Oldest SQLite with `ALTER TABLE ... DROP COLUMN`. */
const MIN_SQLITE_MAJOR = 3;
const MIN_SQLITE_MINOR = 35;

/** Tables dropped in v4 (OLD NAMES ON PURPOSE: this file and the legacy ones are the only places that name them). */
const DROPPED_TABLES = ["stages", "worktrees"] as const;

/** Columns dropped in v4 (only when present). SQLite refuses a column used by an index/view/trigger: the throw rolls back. */
const DROPPED_COLUMNS: Array<[table: string, column: string]> = [
  ["runs", "stage_idx"],
  ["run_messages", "after_plan"],
  ["proposals", "base"],
];

/** Tables that survive: their row counts must be unchanged by the migration. */
const KEPT_TABLES = [
  "turns",
  "runs",
  "approvals",
  "tool_calls",
  "proposals",
  "run_messages",
  "sessions",
] as const;

const countOf = (db: Database, table: string): number =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;

const hasColumn = (db: Database, table: string, column: string): boolean =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);

/**
 * Schema v4: drop the stage and clone data (tables `stages`, `worktrees`; columns `runs.stage_idx`,
 * `run_messages.after_plan`, `proposals.base`). ONE transaction: any throw (incl. a refused DROP COLUMN)
 * rolls everything back and the db stays v3. Kept-table counts are compared inside it; `schema_version`
 * is written last. No-op when the db is already v4. No snapshot is taken here (owner decision).
 */
export function migrateV4(db: Database): void {
  if (schemaVersion(db) >= 4) return;
  const [major = 0, minor = 0] = (
    db.query<{ v: string }, []>("SELECT sqlite_version() AS v").get()?.v ?? ""
  )
    .split(".")
    .map(Number);
  if (major < MIN_SQLITE_MAJOR || (major === MIN_SQLITE_MAJOR && minor < MIN_SQLITE_MINOR))
    throw new Error(`SQLite ${major}.${minor} is too old for the v4 migration (need >= 3.35)`);

  // Any throw (a refused DROP COLUMN, a count mismatch) rolls the transaction back; add the same context to all.
  const { dropped, counts } = (() => {
    try {
      return db.transaction(() => {
        const dropped: Record<string, number> = {};
        for (const t of DROPPED_TABLES) dropped[t] = hasTable(db, t) ? countOf(db, t) : 0;
        const kept = KEPT_TABLES.filter((t) => hasTable(db, t));
        const before = new Map(kept.map((t) => [t, countOf(db, t)]));

        for (const t of DROPPED_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`); // its indexes go with it
        for (const [table, column] of DROPPED_COLUMNS)
          if (hasTable(db, table) && hasColumn(db, table, column))
            db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);

        // Data check inside the tx: a mismatch throws and rolls the whole migration back.
        const counts: Record<string, number> = {};
        for (const t of kept) {
          counts[t] = countOf(db, t);
          if (counts[t] !== before.get(t))
            throw new Error(
              `v4 migration: row count of ${t} changed (${before.get(t)} -> ${counts[t]})`,
            );
        }
        if (db.query("PRAGMA foreign_key_check").all().length > 0)
          throw new Error("v4 migration: foreign_key_check reported rows");
        db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')").run();
        return { dropped, counts };
      })();
    } catch (err) {
      log.error({ err: String(err) }, "db.migrate.failed");
      throw new Error(`v4 migration failed, the db stays at v3: ${String(err)}`);
    }
  })();
  logEvent(log, "db.migrated", { from: 3, to: 4, dropped, counts });
}
