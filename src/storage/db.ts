import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { ensureParentDir, restrictFile } from "../config/workspace-paths";

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
  ended_at INTEGER
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

/** Open (creating if needed) the SQLite db in WAL mode and ensure the schema. */
export function openDb(file: string): Database {
  // ":memory:" is allowed for callers that want a throwaway db.
  const db = new Database(file === ":memory:" ? file : ensureParentDir(file), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  if (file !== ":memory:") {
    // db holds tool output: owner-only, including the WAL/SHM sidecars created before this chmod.
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) restrictFile(f);
  }
  return db;
}
