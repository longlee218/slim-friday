import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { restrictFile } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";

/** Schema version written to `meta` by this migration (the `meta` table is the only version marker). */
export const SCHEMA_VERSION = 2;

const log = logger.child({ module: "db-migrate" });

/** New tables of v2 (all `IF NOT EXISTS`: running them twice is a no-op). */
const V2_TABLES = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stages (
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  cwd TEXT,
  verdict TEXT,
  model TEXT,
  cost_usd REAL,
  started_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY (task_id, idx)
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  from_task_id TEXT,
  role TEXT NOT NULL,
  brief TEXT NOT NULL,
  repo TEXT,
  base TEXT,
  class TEXT,
  scope TEXT,
  confidence REAL,
  reason TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proposals_thread ON proposals(thread_id, status);
`;

/** Additive columns per existing table. Each is nullable or defaulted, so an old binary ignores them. */
const V2_COLUMNS: Record<string, Array<[name: string, ddl: string]>> = {
  tasks: [
    ["role", "TEXT NOT NULL DEFAULT 'dev'"],
    ["kind", "TEXT NOT NULL DEFAULT 'staged'"],
    ["parent_task_id", "TEXT"],
    ["proposal_id", "TEXT"],
    ["hop", "INTEGER NOT NULL DEFAULT 0"],
    ["counts_toward_cap", "INTEGER NOT NULL DEFAULT 1"],
    ["class", "TEXT"],
  ],
  runs: [
    ["stage_idx", "INTEGER"],
    ["model", "TEXT"],
  ],
  // Independent task clone (P2): where it came from and how it was delivered.
  worktrees: [
    ["workspace", "TEXT"],
    ["base_sha", "TEXT"],
    ["origin_url", "TEXT"],
    ["delivery", "TEXT"],
    ["status", "TEXT NOT NULL DEFAULT 'active'"],
    ["patch_path", "TEXT"],
    ["delivered_at", "INTEGER"],
  ],
};

/** True when the table exists. */
const hasTable = (db: Database, name: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** True when the db is a v1 one: it has data tables but no `meta` marker yet (a fresh db has neither). */
export function isV1Db(db: Database): boolean {
  return hasTable(db, "sessions") && !hasTable(db, "meta");
}

/**
 * Write a consistent copy of the db to `<backupDir>/friday-v1-<ts>.db` (`VACUUM INTO`, safe with WAL).
 * Throws on failure: the caller must then abort startup, no migration runs on an unsaved db.
 */
export function snapshotDb(db: Database, backupDir: string, now = new Date()): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const target = join(backupDir, `friday-v1-${ts}.db`);
  // The path is app-built (no owner text); single quotes are doubled anyway as the SQL literal requires.
  db.run(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  restrictFile(target); // holds tool output like the live db: owner-only
  logEvent(log, "db.snapshot", { path: target });
  return target;
}

/** Add the missing columns of `table`; returns the names it added. */
function addMissingColumns(db: Database, table: string, cols: Array<[string, string]>): string[] {
  const have = new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name),
  );
  const added: string[] = [];
  for (const [name, ddl] of cols) {
    if (have.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    added.push(name);
  }
  return added;
}

/**
 * Additive, idempotent migration to schema v2 (stages, proposals, meta + guarded ALTERs). Runs in one
 * transaction: a failure leaves the db as it was. `meta.schema_version` is written last, so a run that
 * did not finish is retried at the next start. Requires the v1 tables to exist (db.ts creates them first).
 */
export function migrate(db: Database): void {
  db.transaction(() => {
    db.exec(V2_TABLES);
    for (const [table, cols] of Object.entries(V2_COLUMNS)) {
      const added = addMissingColumns(db, table, cols);
      // Old Q&A rows must not count against the code-task cap (the new column defaults to 1).
      if (table === "tasks" && added.includes("counts_toward_cap"))
        db.exec("UPDATE tasks SET counts_toward_cap = 0 WHERE type <> 'code'");
    }
    db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
  })();
}
