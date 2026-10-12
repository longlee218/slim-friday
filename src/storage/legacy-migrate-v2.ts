import type { Database } from "bun:sqlite";

/**
 * FROZEN legacy v2 migration (additive tables + columns). OLD NAMES ON PURPOSE: do not edit. Run only
 * while the db is below schema v3 (see legacy-schema.ts).
 */

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
-- Owner messages that arrived while a run worked (Rev 11): content redacted and capped by the store.
CREATE TABLE IF NOT EXISTS run_messages (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  thread_id TEXT NOT NULL,
  session_id TEXT,
  run_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  task_id TEXT,
  after_plan INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_run_messages_thread ON run_messages(thread_id, seq);
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
  // Effort resolved when the request was queued, so queue -> start keeps it (P1.4b).
  proposals: [["effort", "TEXT"]],
  // Task a message was meant for, and whether it changed work after the owner approved the plan (ledger line).
  run_messages: [
    ["task_id", "TEXT"],
    ["after_plan", "INTEGER NOT NULL DEFAULT 0"],
  ],
  runs: [
    ["stage_idx", "INTEGER"],
    ["model", "TEXT"],
  ],
  // Subagent that made the call (P3.1); NULL = the main agent. Task of the run: a running task has no `runs` row yet,
  // so its latest tool (status snapshot, Rev 12) is read by task id.
  tool_calls: [
    ["agent_id", "TEXT"],
    ["task_id", "TEXT"],
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
    // Delivery diffstat summary for the ledger: file count and the top paths (newline separated).
    ["files_changed", "INTEGER"],
    ["files_top", "TEXT"],
  ],
};

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
export function migrateV2(db: Database): void {
  db.transaction(() => {
    db.exec(V2_TABLES);
    for (const [table, cols] of Object.entries(V2_COLUMNS)) {
      const added = addMissingColumns(db, table, cols);
      // Old Q&A rows must not count against the code-task cap (the new column defaults to 1).
      if (table === "tasks" && added.includes("counts_toward_cap"))
        db.exec("UPDATE tasks SET counts_toward_cap = 0 WHERE type <> 'code'");
    }
    db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run("2");
  })();
}
