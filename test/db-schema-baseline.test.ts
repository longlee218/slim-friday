import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/storage/db";

/** Column names of a table of the db. */
const cols = (db: Database, table: string): string[] =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);

/** Every table the stores use and the columns they read or write (dropped ones are asserted absent below). */
const EXPECTED: Record<string, string[]> = {
  approvals: ["id", "turn_id", "tool", "summary", "decision", "requested_at", "decided_at"],
  artifacts: [
    "id",
    "workspace",
    "channel",
    "goal_id",
    "task_id",
    "thread_id",
    "title",
    "name",
    "kind",
    "origin",
    "path",
    "location",
    "producer_role",
    "version",
    "size",
    "source_mtime",
    "summary",
    "created_at",
  ],
  effect_log: [
    "id",
    "thread_id",
    "goal_id",
    "item_id",
    "tool",
    "scope",
    "granted_by",
    "result",
    "undo",
    "created_at",
  ],
  memory_files: ["path", "workspace", "mtime_ms", "size"],
  memory_promotions: ["workspace", "channel", "hash", "promoted_at"],
  owned_tasks: [
    "id",
    "thread_id",
    "owner_role",
    "status",
    "scope",
    "version",
    "correlation_id",
    "created_at",
    "last_progress_at",
    "parent_id",
    "item_key",
    "depends_on",
    "attempt",
    "dispatch_count",
    "location",
    "brief",
    "result_kind",
    "result_path",
    "result_excerpt",
    "structure_owner",
    "priority",
    "subject",
  ],
  run_messages: [
    "id",
    "message_id",
    "thread_id",
    "session_id",
    "run_id",
    "seq",
    "kind",
    "status",
    "content",
    "created_at",
    "task_id",
  ],
  runs: [
    "id",
    "turn_id",
    "model",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "cost_usd",
    "turns",
    "duration_ms",
    "outcome",
    "compactions",
  ],
  sessions: [
    "thread_id",
    "session_id",
    "location",
    "cwd",
    "status",
    "updated_at",
    "model",
    "generation",
    "kind",
  ],
  thread_events: [
    "seq",
    "id",
    "thread_id",
    "task_id",
    "item_id",
    "kind",
    "payload",
    "correlation_id",
    "causation_id",
    "created_at",
    "claimed_by",
    "delivered_at",
    "redelivered",
  ],
  thread_summaries: [
    "thread_id",
    "workspace",
    "summary",
    "channel",
    "key_topics",
    "abstract",
    "promoted_at",
    "updated_at",
    "cycle",
    "flushed_cycle",
  ],
  threads: [
    "thread_id",
    "channel_id",
    "workspace",
    "origin",
    "placeholder",
    "title",
    "digest",
    "created_at",
    "updated_at",
  ],
  tool_calls: [
    "id",
    "run_id",
    "tool",
    "input_json",
    "output_preview",
    "is_error",
    "duration_ms",
    "agent_id",
    "turn_id",
  ],
  item_questions: ["message_id", "thread_id", "item_id", "created_at"],
  turns: [
    "id",
    "thread_id",
    "source",
    "location",
    "status",
    "started_at",
    "ended_at",
    "session_id",
    "brief",
    "role",
    "kind",
    "parent_turn_id",
    "hop",
    "counts_toward_cap",
    "owned_task_id",
  ],
  work_plans: [
    "id",
    "version",
    "goal_id",
    "status",
    "strategy",
    "objective",
    "body",
    "acceptance",
    "envelope",
    "budget_usd",
    "effects",
    "reason",
    "created_at",
    "approved_at",
  ],
};

test("fresh db has exactly the baseline tables and columns", () => {
  const db = openDb(":memory:");
  for (const [table, expected] of Object.entries(EXPECTED))
    expect(cols(db, table).sort(), table).toEqual([...expected].sort());
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_fts_%' AND name NOT LIKE 'artifacts_fts_%'",
    )
    .all()
    .map((r) => r.name);
  expect(tables.sort()).toEqual(
    [...Object.keys(EXPECTED), "__drizzle_migrations", "artifacts_fts", "memory_fts"].sort(),
  );
  // Dropped with the v8 chain: no proposals/meta table, no dead columns.
  expect(tables).not.toContain("proposals");
  expect(tables).not.toContain("meta");
  db.close();
});

test("memory_fts matches through diacritics", () => {
  const db = openDb(":memory:");
  db.run(
    "INSERT INTO memory_fts (text, orig, id, source, section, kind, date, workspace, path) VALUES ('Việt café', 'o', 'i', 's', 'x', 'k', 'd', 'w', 'p')",
  );
  expect(db.query("SELECT id FROM memory_fts WHERE memory_fts MATCH 'cafe'").all()).toHaveLength(1);
  expect(db.query("SELECT id FROM memory_fts WHERE memory_fts MATCH 'viet'").all()).toHaveLength(1);
  db.close();
});

test("reopening a file db is a no-op and a foreign db is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-baseline-"));
  try {
    const file = join(dir, "data", "agent.db");
    const a = openDb(file);
    a.run(
      "INSERT INTO threads (thread_id, channel_id, origin, created_at, updated_at) VALUES ('t','c','bot',1,1)",
    );
    a.close();
    const b = openDb(file);
    expect(b.query("SELECT thread_id FROM threads").all()).toHaveLength(1);
    expect(b.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 11 });
    b.close();

    const foreign = join(dir, "foreign.db");
    const f = new Database(foreign, { create: true });
    f.run("CREATE TABLE sessions (thread_id TEXT PRIMARY KEY)");
    f.close();
    expect(() => openDb(foreign)).toThrow(
      /is not a Friday baseline database: stop the bot, delete it and <AGENT_HOME>/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the migrations folder resolves from another cwd", () => {
  const cwd = process.cwd();
  const other = mkdtempSync(join(tmpdir(), "friday-cwd-"));
  try {
    process.chdir(other);
    const db = openDb(":memory:");
    expect(cols(db, "turns")).toContain("id");
    db.close();
  } finally {
    process.chdir(cwd);
    rmSync(other, { recursive: true, force: true });
  }
});
