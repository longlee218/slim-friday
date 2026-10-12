import type { Database } from "bun:sqlite";
import { logEvent, logger } from "../observability/logger";
import { hasTable, schemaVersion } from "./migrate";

const log = logger.child({ module: "db-migrate" });

/** Oldest SQLite with safe RENAME TABLE / RENAME COLUMN reference rewriting. */
const MIN_SQLITE_MAJOR = 3;
const MIN_SQLITE_MINOR = 35;

/**
 * Columns renamed in v3 (OLD NAMES ON PURPOSE, the only place besides the legacy files). A turn is one handled
 * message: its row is `turns`, and every every-turn table points at it. `worktrees.task_id` and
 * `run_messages.task_id` are NOT here: they refer to staged tasks only and keep their name.
 */
const COLUMN_RENAMES: Array<[table: string, from: string, to: string]> = [
  ["turns", "parent_task_id", "parent_turn_id"],
  ["runs", "task_id", "turn_id"],
  ["approvals", "task_id", "turn_id"],
  ["tool_calls", "task_id", "turn_id"],
  ["stages", "task_id", "turn_id"],
  ["proposals", "from_task_id", "from_turn_id"],
];

/** Tables whose row counts must survive the migration unchanged (key = name before, value = name after). */
const COUNTED: Array<[before: string, after: string]> = [
  ["tasks", "turns"],
  ["runs", "runs"],
  ["approvals", "approvals"],
  ["tool_calls", "tool_calls"],
  ["stages", "stages"],
  ["proposals", "proposals"],
  ["worktrees", "worktrees"],
  ["run_messages", "run_messages"],
  ["sessions", "sessions"],
];

const columns = (db: Database, table: string): string[] =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);

const countOf = (db: Database, table: string): number =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;

/**
 * Schema v3: table `tasks` -> `turns` and the turn-pointing columns renamed (see COLUMN_RENAMES). Runs in ONE
 * transaction (a throw rolls everything back, the db stays v2); row counts are compared inside it; the
 * `schema_version` row is written last. No-op when the db is already v3. The caller snapshots the db first.
 */
export function migrateV3(db: Database): void {
  if (schemaVersion(db) >= 3) return;
  const [major = 0, minor = 0] = (
    db.query<{ v: string }, []>("SELECT sqlite_version() AS v").get()?.v ?? ""
  )
    .split(".")
    .map(Number);
  if (major < MIN_SQLITE_MAJOR || (major === MIN_SQLITE_MAJOR && minor < MIN_SQLITE_MINOR))
    throw new Error(`SQLite ${major}.${minor} is too old for the v3 migration (need >= 3.35)`);

  const counts = db.transaction(() => {
    // Both tables present = an unknown state (a half-made or hand-edited db): never guess, roll back.
    if (hasTable(db, "tasks") && hasTable(db, "turns"))
      throw new Error("v3 migration: both `tasks` and `turns` exist, refusing to guess");
    const before = new Map<string, number>();
    for (const [t] of COUNTED) if (hasTable(db, t)) before.set(t, countOf(db, t));

    if (hasTable(db, "tasks")) db.exec("ALTER TABLE tasks RENAME TO turns");
    for (const [table, from, to] of COLUMN_RENAMES) {
      const have = columns(db, table);
      if (have.includes(from) && !have.includes(to))
        db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
    }
    // RENAME TABLE keeps the old index names: drop and re-create under the new ones.
    db.exec(`
      DROP INDEX IF EXISTS idx_tasks_thread;
      DROP INDEX IF EXISTS idx_runs_task;
      CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns(thread_id);
      CREATE INDEX IF NOT EXISTS idx_runs_turn ON runs(turn_id);
    `);

    // Data check inside the tx: a mismatch throws and rolls the whole migration back.
    const after: Record<string, number> = {};
    for (const [b, a] of COUNTED) {
      if (!before.has(b)) continue;
      after[a] = countOf(db, a);
      if (after[a] !== before.get(b))
        throw new Error(
          `v3 migration: row count of ${b} changed (${before.get(b)} -> ${after[a]})`,
        );
    }
    if (db.query("PRAGMA foreign_key_check").all().length > 0)
      throw new Error("v3 migration: foreign_key_check reported rows");
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')").run();
    return after;
  })();
  logEvent(log, "db.migrated", { from: 2, to: 3, counts });
}
