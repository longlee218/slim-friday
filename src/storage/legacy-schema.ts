import type { Database } from "bun:sqlite";
import { migrateV2 } from "./legacy-migrate-v2";

/**
 * FROZEN legacy schema (v1 DDL + v2 additive migration). OLD NAMES ON PURPOSE (`tasks`, `task_id`,
 * `parent_task_id`, `from_task_id`): do not edit. It runs only while the db is below schema v3, then
 * `migrate-v3-turns.ts` renames the objects; a v3 db never executes any of this (it would re-create an
 * empty `tasks` table).
 */

/** Schema; idempotent so it runs on every start. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  thread_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  source TEXT NOT NULL,
  repo TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  session_id TEXT,
  session_cwd TEXT,
  brief TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  compactions INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_preview TEXT NOT NULL,
  is_error INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  decision TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS worktrees (
  task_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base TEXT NOT NULL,
  pr_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worktrees_thread ON worktrees(thread_id);
CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id);
`;

/**
 * Bring any pre-v3 db (fresh, v1 or v2) to the v2 shape: v1 DDL, the old idempotent column additions,
 * then the v2 migration.
 */
export function applyLegacySchema(db: Database): void {
  db.exec(SCHEMA);
  // Idempotent column additions for databases created by older versions.
  const have = db
    .query<{ name: string }, []>("PRAGMA table_info(tasks)")
    .all()
    .map((c) => c.name);
  for (const col of ["session_id", "session_cwd", "brief"])
    if (!have.includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
  migrateV2(db);
}
