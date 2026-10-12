import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommand } from "../src/orchestrator/message-routing";
import { deriveThreadState } from "../src/orchestrator/thread/thread-state";
import { openDb } from "../src/storage/db";
import { threadLedger } from "../src/storage/ledger-store";
import { applyLegacySchema } from "../src/storage/legacy-schema";
import { migrateV3 } from "../src/storage/migrate-v3-turns";
import { insertTurn, latestTurnSession } from "../src/storage/run-store";

// OLD NAMES ON PURPOSE: this file builds the v2 (pre-turns) database and checks the v2 -> v3 migration.
// Tmp dirs only: it never touches a real home.

/** Tables whose rows must survive: [name before, name after]. */
const TABLES: Array<[string, string]> = [
  ["tasks", "turns"],
  ["runs", "runs"],
  ["tool_calls", "tool_calls"],
  ["approvals", "approvals"],
  ["stages", "stages"],
  ["proposals", "proposals"],
  ["run_messages", "run_messages"],
  ["worktrees", "worktrees"],
  ["sessions", "sessions"],
];

/** Seed rows in every table, in the v2 shape (4 turns incl. in-flight, failed_resumable with a parent). */
const SEED = `
INSERT INTO sessions VALUES ('th1', 'sess-1', 'repo', '/r', 'active', 1), ('th2', 'sess-2', 'repo', '/r', 'active', 2);
INSERT INTO tasks (id, thread_id, source, repo, type, status, started_at, ended_at, session_id, session_cwd, brief, role, kind, parent_task_id, proposal_id, hop, counts_toward_cap, class) VALUES
 ('t1', 'th1', 'discord', 'repo', 'qa', 'done', 1, 2, 's1', '/c1', NULL, 'assistant', 'single', NULL, NULL, 0, 0, NULL),
 ('t2', 'th2', 'discord', 'repo', 'code', 'running', 3, NULL, 's2', '/c2', 'build it', 'dev', 'staged', NULL, 'p1', 0, 1, 'standard'),
 ('t3', 'th2', 'discord', 'repo', 'code', 'failed_resumable', 4, 5, 's3', '/c3', 'fix it', 'dev', 'staged', 't2', NULL, 1, 1, 'design'),
 ('t4', 'th1', 'discord', 'repo', 'code', 'interrupted', 6, 7, NULL, NULL, 'x', 'dev', 'staged', NULL, NULL, 0, 1, NULL);
INSERT INTO runs (id, task_id, model, input_tokens, cost_usd, turns, outcome, stage_idx) VALUES
 ('r1', 't1', 'm', 10, 0.25, 2, 'success', NULL), ('r2', 't2', 'm', 20, 0.5, 3, 'success', 0), ('r3', 't3', 'm', 30, 1.125, 4, 'error', 1);
INSERT INTO tool_calls (id, run_id, tool, input_json, output_preview, agent_id, task_id) VALUES
 ('c1', 'r1', 'Read', '{}', 'a', NULL, 't1'), ('c2', 'r2', 'Bash', '{}', 'b', 'ag', 't2'), ('c3', 'r3', 'Edit', '{}', 'c', NULL, 't3');
INSERT INTO approvals VALUES ('a1', 't2', 'Bash', 'ls', 'approved', 1, 2), ('a2', 't3', 'Edit', 'x', 'pending', 3, NULL);
INSERT INTO stages (task_id, idx, name, status, cost_usd) VALUES
 ('t1', 0, 'qa', 'done', 0.25), ('t2', 0, 'plan', 'done', 0.5), ('t2', 1, 'exec', 'running', NULL), ('t3', 0, 'plan', 'done', 1), ('t3', 1, 'exec', 'failed', 0.125);
INSERT INTO proposals (id, thread_id, workspace, from_task_id, role, brief, status, created_at) VALUES
 ('p1', 'th2', 'main', 't1', 'dev', 'b', 'started', 1), ('p2', 'th1', 'main', NULL, 'dev', 'b2', 'pending', 2);
INSERT INTO run_messages (id, thread_id, seq, kind, status, content, created_at, task_id) VALUES
 ('m1', 'th2', 1, 'steer', 'pending', 'hi', 1, 't2'), ('m2', 'th2', 2, 'steer', 'applied', 'yo', 2, NULL);
INSERT INTO worktrees (task_id, thread_id, repo, repo_path, path, branch, base, created_at) VALUES
 ('t2', 'th2', 'repo', '/r', '/w2', 'agent/t2', 'main', 1), ('t3', 'th2', 'repo', '/r', '/w3', 'agent/t3', 'main', 2);
`;

/** Temp home with `data/agent.db` in the v2 shape plus the seed rows. */
function v2Home(extraSql = "") {
  const home = mkdtempSync(join(tmpdir(), "friday-v3-"));
  mkdirSync(join(home, "data"));
  const file = join(home, "data", "agent.db");
  const raw = new Database(file, { create: true });
  applyLegacySchema(raw); // the frozen legacy steps build the exact v2 shape
  raw.exec(SEED);
  if (extraSql) raw.exec(extraSql);
  raw.close();
  return { home, file, backups: join(home, "db-backups") };
}

/** Open the fixture and run ONLY the v2 -> v3 step (no snapshot, no v4): the v3 shape is what these tests probe. */
function openV3(file: string): Database {
  const db = new Database(file);
  migrateV3(db);
  return db;
}

/** TABLES minus the ones v4 drops: their counts must survive the whole chain. */
const KEPT_TABLES = TABLES.filter(([b]) => b !== "stages" && b !== "worktrees");

/** All rows of a table as arrays of column values (column position, rowid order). */
const rowsOf = (db: Database, table: string) =>
  db.query(`SELECT * FROM ${table} ORDER BY rowid`).values();
const names = (db: Database, kind: string) =>
  db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = ? ORDER BY name",
    )
    .all(kind)
    .map((r) => r.name);
const cols = (db: Database, table: string) =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
const version = (db: Database) =>
  db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()
    ?.value;

/** Capture every table's rows (old names) from the v2 file before the migration runs. */
function capture(file: string) {
  const raw = new Database(file, { readonly: true });
  const out = Object.fromEntries(TABLES.map(([before]) => [before, rowsOf(raw, before)]));
  raw.close();
  return out;
}

test("a. migrate: no throw, v2 backup exists and still holds the old names with equal counts", () => {
  const { file, backups } = v2Home();
  const before = capture(file);
  openDb(file).close();
  const snaps = readdirSync(backups);
  expect(snaps).toHaveLength(1);
  expect(snaps[0]).toMatch(/^friday-v2-.*\.db$/);
  const snap = new Database(join(backups, snaps[0]!), { readonly: true });
  expect(names(snap, "table")).toContain("tasks");
  expect(names(snap, "table")).not.toContain("turns");
  for (const [b] of TABLES) expect(rowsOf(snap, b)).toEqual(before[b]!);
  snap.close();
});

test("b. shape: new names, indexes, stages PK, no FKs, integrity ok, version 3 (v3 step alone)", () => {
  const { file } = v2Home();
  const db = openV3(file);
  const tables = names(db, "table");
  expect(tables).toContain("turns");
  expect(tables).not.toContain("tasks");
  expect(names(db, "index")).toEqual(
    expect.arrayContaining(["idx_turns_thread", "idx_runs_turn", "idx_worktrees_thread"]),
  );
  expect(names(db, "index")).not.toContain("idx_tasks_thread");
  expect(names(db, "index")).not.toContain("idx_runs_task");
  const idx = (n: string) =>
    db
      .query<{ name: string }, []>(`PRAGMA index_info(${n})`)
      .all()
      .map((c) => c.name);
  expect(idx("idx_turns_thread")).toEqual(["thread_id"]);
  expect(idx("idx_runs_turn")).toEqual(["turn_id"]);
  for (const t of ["runs", "approvals", "tool_calls", "stages"]) {
    expect(cols(db, t)).toContain("turn_id");
    expect(cols(db, t)).not.toContain("task_id");
  }
  expect(cols(db, "turns")).toContain("parent_turn_id");
  expect(cols(db, "turns")).not.toContain("parent_task_id");
  expect(cols(db, "proposals")).toContain("from_turn_id");
  expect(cols(db, "proposals")).not.toContain("from_task_id");
  // Staged-task-only tables keep their column.
  expect(cols(db, "worktrees")).toContain("task_id");
  expect(cols(db, "run_messages")).toContain("task_id");
  const pk = db
    .query<{ name: string; pk: number }, []>("PRAGMA table_info(stages)")
    .all()
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  expect(pk).toEqual(["turn_id", "idx"]);
  for (const t of tables) expect(db.query(`PRAGMA foreign_key_list(${t})`).all()).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()).toEqual({
    integrity_check: "ok",
  });
  expect(version(db)).toBe("3");
});

test("c. data: every row equal by column position, sums and joins equal, in-flight row intact", () => {
  const { file } = v2Home();
  const before = capture(file);
  const db = openV3(file);
  for (const [b, a] of TABLES) expect(rowsOf(db, a)).toEqual(before[b]!);
  expect(db.query("SELECT SUM(cost_usd) AS s FROM runs").get()).toEqual({ s: 1.875 });
  expect(
    db.query("SELECT COUNT(*) AS n FROM runs r JOIN turns t ON t.id = r.turn_id").get(),
  ).toEqual({ n: 3 });
  expect(db.query("SELECT id, status, session_id FROM turns WHERE id = 't2'").get()).toEqual({
    id: "t2",
    status: "running",
    session_id: "s2",
  });
  expect(db.query("SELECT parent_turn_id FROM turns WHERE id = 't3'").get()).toEqual({
    parent_turn_id: "t2",
  });
});

test("d. readers work on the migrated db", () => {
  const { file } = v2Home();
  const db = openV3(file);
  insertTurn(db, { id: "t5", threadId: "th3", source: "s", repo: "r", role: "assistant" });
  expect(db.query("SELECT COUNT(*) AS n FROM turns").get()).toEqual({ n: 5 });
  // The migrated `stages` rows stay on disk (dropped by v4) but nothing reads them any more.
  expect(db.query("SELECT COUNT(*) AS n FROM stages WHERE turn_id = 't2'").get()).toEqual({ n: 2 });
  expect(latestTurnSession(db, "th2")).toMatchObject({
    id: "t3",
    sessionId: "s3",
    budgetStopped: false,
  });
  const ledger = threadLedger(db, "th2");
  expect(ledger).toContain('- t2 dev, running: "build it"');
  expect(ledger).toContain("  repo repo, cost $0.50"); // the sum of the task's `runs`
  expect(deriveThreadState(db, "th2")).toBe("idle"); // last turn t3 is failed_resumable
});

test("e. second and third open: no new backup, same schema, same counts (no-op)", () => {
  const { file, backups } = v2Home();
  openDb(file).close();
  const second = openDb(file);
  const sql = (d: Database) =>
    d.query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master ORDER BY name").all();
  const schema = sql(second);
  const counts = KEPT_TABLES.map(([, a]) => rowsOf(second, a).length);
  second.close();
  const third = openDb(file);
  expect(sql(third)).toEqual(schema);
  expect(KEPT_TABLES.map(([, a]) => rowsOf(third, a).length)).toEqual(counts);
  expect(names(third, "table")).not.toContain("tasks"); // legacy DDL did not re-create it
  expect(readdirSync(backups)).toHaveLength(1);
});

test("f. failure: a pre-existing `turns` table aborts, rolls back, keeps tasks rows and version 2", () => {
  const { file, backups } = v2Home("CREATE TABLE turns (id TEXT);");
  expect(() => openDb(file)).toThrow(/both `tasks` and `turns` exist/);
  const raw = new Database(file, { readonly: true });
  expect(raw.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 4 });
  expect(cols(raw, "runs")).toContain("task_id");
  expect(version(raw)).toBe("2");
  raw.close();
  expect(readdirSync(backups)).toHaveLength(1);
});

test("g. v1 db chains to v5: version 5, exactly one backup and it is the v1 one", () => {
  const home = mkdtempSync(join(tmpdir(), "friday-v3-"));
  mkdirSync(join(home, "data"));
  const file = join(home, "data", "agent.db");
  const raw = new Database(file, { create: true });
  raw.exec(`
    CREATE TABLE sessions (thread_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, repo TEXT NOT NULL,
      cwd TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, source TEXT NOT NULL, repo TEXT NOT NULL,
      type TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
      session_id TEXT, session_cwd TEXT, brief TEXT);
    INSERT INTO sessions VALUES ('th1', 's', 'r', '/r', 'active', 1);
    INSERT INTO tasks (id, thread_id, source, repo, type, status, started_at) VALUES ('t1', 'th1', 'd', 'r', 'code', 'done', 1);
  `);
  raw.close();
  const db = openDb(file);
  expect(version(db)).toBe("5");
  expect(db.query("SELECT COUNT(*) AS n FROM turns").get()).toEqual({ n: 1 });
  const snaps = readdirSync(join(home, "db-backups"));
  expect(snaps).toHaveLength(1);
  expect(snaps[0]).toMatch(/^friday-v1-/);
});

test("h. fresh file db and :memory: land on v5 with the new names and no backup", () => {
  const home = mkdtempSync(join(tmpdir(), "friday-v3-"));
  const file = join(home, "data", "agent.db");
  const db = openDb(file);
  expect(version(db)).toBe("5");
  expect(names(db, "table")).toContain("turns");
  expect(names(db, "table")).not.toContain("tasks");
  expect(cols(db, "runs")).toContain("turn_id");
  expect(() => readdirSync(join(home, "db-backups"))).toThrow(); // no backup dir at all
  const mem = openDb(":memory:");
  expect(version(mem)).toBe("5");
  expect(names(mem, "table")).toContain("turns");
});

test("backup failure on a v2 db aborts startup and leaves it untouched", () => {
  const { file, home } = v2Home();
  const blocked = join(home, "blocked");
  writeFileSync(blocked, "x"); // a file where the backup dir should be
  expect(() => openDb(file, blocked)).toThrow(/snapshot failed/);
  const raw = new Database(file, { readonly: true });
  expect(version(raw)).toBe("2");
  expect(names(raw, "table")).toContain("tasks");
  raw.close();
});

test("g. an old db with a worktrees row and a failed_resumable dev turn opens; `/go` continues its saved session in its cwd (no clone, no plan file)", () => {
  const { home, file } = v2Home();
  const db = openDb(file);
  // t3 (th2's last turn, `failed_resumable`, session s3, with a legacy worktrees row) ran in a dir that still exists.
  const cwd = mkdtempSync(join(tmpdir(), "friday-v3-cwd-"));
  db.query("UPDATE turns SET session_cwd = ? WHERE id = 't3'").run(cwd);
  // The session cwd is a registered repo of the workspace: the dev run may continue in it.
  const repo = { name: "web", workspace: "main", dir: cwd, path: cwd, description: "" };
  const r = resolveCommand(
    { db, agentHome: home, workspace: "main", repos: [repo] },
    { kind: "resume" },
    "th2",
  );
  expect(r).toMatchObject({
    cmd: { kind: "message", role: "dev" },
    resume: { sessionId: "s3", cwd, of: "t3" },
  });
});

test("g1. an old-shaped dev session whose cwd is a task scratch dir (no registered repo) is not resumed as dev", () => {
  const { home, file } = v2Home();
  const db = openDb(file);
  // The dir exists (an old plan-run scratch dir) but is not one of the workspace repos.
  const scratch = mkdtempSync(join(tmpdir(), "friday-v3-scratch-"));
  db.query("UPDATE turns SET session_cwd = ? WHERE id = 't3'").run(scratch);
  const other = mkdtempSync(join(tmpdir(), "friday-v3-repo-"));
  const repo = { name: "web", workspace: "main", dir: other, path: other, description: "" };
  const r = resolveCommand(
    { db, agentHome: home, workspace: "main", repos: [repo] },
    { kind: "resume" },
    "th2",
  );
  expect(r).toMatchObject({ reason: "resume_gone" });
});

test("g2. the same turn whose cwd is gone: `/go` refuses, the task becomes failed (nothing to continue)", () => {
  const { home, file } = v2Home();
  const db = openDb(file);
  const r = resolveCommand(
    { db, agentHome: home, workspace: "main", repos: [] },
    { kind: "resume" },
    "th2",
  );
  expect(r).toMatchObject({ reason: "resume_gone" });
  expect(db.query("SELECT status FROM turns WHERE id = 't3'").get()).toEqual({ status: "failed" });
});
