import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addUsage, emptyUsage } from "../src/observability/record-run";
import { openDb } from "../src/storage/db";
import { countActiveCappedTasks, insertTurn } from "../src/storage/run-store";
import { getWorktreeByTask } from "../src/storage/worktree-store";

/** The v1 schema as the bot shipped it before the migration (no meta table, no stages / proposals). */
const V1 = `
CREATE TABLE sessions (thread_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, repo TEXT NOT NULL,
  cwd TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, source TEXT NOT NULL, repo TEXT NOT NULL,
  type TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  session_id TEXT, session_cwd TEXT, brief TEXT);
CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL, compactions INTEGER NOT NULL DEFAULT 0);
CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, tool TEXT NOT NULL,
  summary TEXT NOT NULL, decision TEXT NOT NULL, requested_at INTEGER NOT NULL, decided_at INTEGER);
INSERT INTO sessions VALUES ('th1', 'sess-1', 'repo', '/r', 'active', 1);
INSERT INTO sessions VALUES ('th2', 'sess-2', 'repo', '/r', 'active', 2);
INSERT INTO tasks (id, thread_id, source, repo, type, status, started_at, brief)
  VALUES ('t-qa', 'th1', 'discord', 'repo', 'qa', 'running', 1, NULL);
INSERT INTO tasks (id, thread_id, source, repo, type, status, started_at, brief)
  VALUES ('t-code', 'th2', 'discord', 'repo', 'code', 'running', 2, 'do it');
INSERT INTO runs (id, task_id, model, outcome) VALUES ('r1', 't-qa', 'm', 'success');
INSERT INTO approvals VALUES ('a1', 't-code', 'Bash', 'ls', 'approved', 1, 2);
`;

/** Temp home with `data/agent.db` holding the v1 fixture; returns the db path and the backup dir. */
function v1Home() {
  const home = mkdtempSync(join(tmpdir(), "friday-migrate-"));
  mkdirSync(join(home, "data"));
  const file = join(home, "data", "agent.db");
  const raw = new Database(file, { create: true });
  raw.exec(V1);
  raw.close();
  return { home, file, backups: join(home, "db-backups") };
}

const count = (db: Database, table: string) =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;

test("v1 db survives: rows kept, new tables + columns, version marker, defaults for old rows", () => {
  const { file } = v1Home();
  const db = openDb(file);
  expect([
    count(db, "sessions"),
    count(db, "turns"),
    count(db, "runs"),
    count(db, "approvals"),
  ]).toEqual([2, 2, 1, 1]);
  expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
    value: "3",
  });
  expect(count(db, "stages")).toBe(0);
  expect(count(db, "proposals")).toBe(0);
  const old = db
    .query(
      "SELECT id, role, kind, hop, counts_toward_cap, class, proposal_id FROM turns ORDER BY id",
    )
    .all();
  expect(old).toEqual([
    {
      id: "t-code",
      role: "dev",
      kind: "staged",
      hop: 0,
      counts_toward_cap: 1,
      class: null,
      proposal_id: null,
    },
    {
      id: "t-qa",
      role: "dev",
      kind: "staged",
      hop: 0,
      counts_toward_cap: 0,
      class: null,
      proposal_id: null,
    },
  ]);
  expect(db.query("SELECT stage_idx FROM runs").get()).toEqual({ stage_idx: null });
  expect(db.query("SELECT session_id FROM sessions WHERE thread_id = 'th2'").get()).toEqual({
    session_id: "sess-2",
  });
});

test("snapshot of the v1 db is written once, before the migration, and is itself v1", () => {
  const { file, backups } = v1Home();
  openDb(file).close();
  const snaps = readdirSync(backups);
  expect(snaps).toHaveLength(1);
  expect(snaps[0]).toMatch(/^friday-v1-.*\.db$/);
  const snap = new Database(join(backups, snaps[0]!), { readonly: true });
  expect(snap.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 2 });
  expect(snap.query("SELECT name FROM sqlite_master WHERE name = 'meta'").get()).toBeNull();
  snap.close();
});

test("migration is idempotent: a second and third open change nothing and take no new snapshot", () => {
  const { file, backups } = v1Home();
  openDb(file).close();
  const db = openDb(file);
  db.close();
  const again = openDb(file);
  expect(count(again, "meta")).toBe(1);
  expect(count(again, "turns")).toBe(2);
  expect(readdirSync(backups)).toHaveLength(1);
  expect(
    again
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .filter((c) => c.name === "role"),
  ).toHaveLength(1);
});

test("fresh db: version marker written, no snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), "friday-migrate-"));
  const db = openDb(join(home, "data", "agent.db"));
  expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
    value: "3",
  });
  expect(existsSync(join(home, "db-backups"))).toBe(false);
});

test("snapshot failure aborts startup and leaves the v1 db unmigrated", () => {
  const { file, home } = v1Home();
  // The backup "dir" is a regular file: mkdir / VACUUM INTO cannot succeed.
  const blocked = join(home, "blocked");
  writeFileSync(blocked, "x");
  expect(() => openDb(file, blocked)).toThrow(/snapshot failed/);
  const raw = new Database(file, { readonly: true });
  expect(
    raw.query("SELECT name FROM sqlite_master WHERE name IN ('meta', 'stages', 'proposals')").all(),
  ).toEqual([]);
  expect(raw.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 2 });
  raw.close();
});

test("cap query counts code tasks only (counts_toward_cap), not Q&A", () => {
  const { file } = v1Home();
  const db = openDb(file);
  expect(countActiveCappedTasks(db)).toBe(1); // the v1 code task; the v1 Q&A row was backfilled to 0
  insertTurn(db, { id: "q2", threadId: "x", source: "s", repo: "r", role: "assistant" });
  insertTurn(db, {
    id: "c2",
    threadId: "x",
    source: "s",
    repo: "r",
    role: "dev",
    cls: "design",
    proposalId: "p1",
  });
  expect(countActiveCappedTasks(db)).toBe(2);
  expect(
    db.query("SELECT class, proposal_id, counts_toward_cap FROM turns WHERE id = 'c2'").get(),
  ).toEqual({
    class: "design",
    proposal_id: "p1",
    counts_toward_cap: 1,
  });
});

test("worktrees: clone columns are added; an old row reads back as a legacy row (no base sha, active)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mig-wt-"));
  const file = join(dir, "data", "agent.db");
  mkdirSync(join(dir, "data"));
  const old = new Database(file);
  old.exec(V1);
  old.exec(
    "CREATE TABLE worktrees (task_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, repo TEXT NOT NULL, repo_path TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, pr_url TEXT, created_at INTEGER NOT NULL)",
  );
  old.exec(
    "INSERT INTO worktrees VALUES ('t1', 'th1', 'r', '/r', '/w', 'agent/t1', 'main', NULL, 5)",
  );
  old.close();
  const db = openDb(file);
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(worktrees)")
    .all()
    .map((c) => c.name);
  for (const c of [
    "workspace",
    "base_sha",
    "origin_url",
    "delivery",
    "status",
    "patch_path",
    "delivered_at",
  ])
    expect(cols).toContain(c);
  expect(getWorktreeByTask(db, "t1")).toMatchObject({
    baseSha: null,
    workspace: null,
    delivery: null,
    status: "active",
  });
  openDb(file).close(); // idempotent
});

test("proposals.effort: added once on the v1 -> v3 chain, old rows read null, re-open keeps it (idempotent)", () => {
  const { file } = v1Home();
  const cols = (d: Database) =>
    d
      .query<{ name: string }, []>("PRAGMA table_info(proposals)")
      .all()
      .filter((c) => c.name === "effort");
  const db = openDb(file);
  expect(cols(db)).toHaveLength(1);
  db.run(
    "INSERT INTO proposals (id, thread_id, workspace, role, brief, status, created_at) VALUES ('p1', 'th1', 'main', 'dev', 'b', 'pending', 1)",
  );
  const effort = () =>
    db.query<{ effort: string | null }, []>("SELECT effort FROM proposals").get()?.effort;
  expect(effort()).toBeNull();
  db.close();
  const again = openDb(file);
  expect(cols(again)).toHaveLength(1);
  again.close();
  expect(cols(openDb(file))).toHaveLength(1);
});

test("run_messages (Rev 11): created on a v1 db, second open is a no-op, rows survive, existing tables untouched", () => {
  const { file } = v1Home();
  const db = openDb(file);
  expect(count(db, "run_messages")).toBe(0);
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(run_messages)")
    .all()
    .map((c) => c.name);
  expect(cols).toEqual([
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
    "after_plan",
  ]);
  db.query(
    "INSERT INTO run_messages (id, thread_id, seq, kind, status, content, created_at) VALUES ('m1', 'th1', 1, 'steer', 'pending', 'hi', 1)",
  ).run();
  db.close();
  const again = openDb(file); // guarded, idempotent: nothing is dropped or re-created
  expect(count(again, "run_messages")).toBe(1);
  expect(count(again, "turns")).toBe(2);
});

test("tool_calls.agent_id and turn_id (renamed from the v2 task_id) end up on an old table, migration stays idempotent", () => {
  const { file } = v1Home();
  const raw = new Database(file);
  raw.exec(
    "CREATE TABLE tool_calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, tool TEXT NOT NULL, input_json TEXT NOT NULL, output_preview TEXT NOT NULL, is_error INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0)",
  );
  raw.close();
  for (let n = 0; n < 2; n++) {
    const db = openDb(file);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(tool_calls)").all();
    expect(cols.filter((c) => c.name === "agent_id")).toHaveLength(1);
    expect(cols.filter((c) => c.name === "turn_id")).toHaveLength(1);
    expect(cols.filter((c) => c.name === "task_id")).toHaveLength(0);
    db.close();
  }
});

test("modelUsage merge is cumulative (per-field max), a new model key is added; top-level tokens are summed", () => {
  const e = (n: number) => ({
    inputTokens: n,
    outputTokens: n,
    cacheReadTokens: n,
    cacheCreationTokens: n,
    costUsd: n,
  });
  const a = emptyUsage();
  a.inputTokens = 5;
  a.modelUsage = { sonnet: e(10) };
  const b = emptyUsage();
  b.inputTokens = 3;
  b.modelUsage = { sonnet: e(4), haiku: e(2) }; // second result smaller + a new model
  const m = addUsage(a, b);
  expect(m.inputTokens).toBe(8);
  expect(m.modelUsage).toEqual({ sonnet: e(10), haiku: e(2) });
});
