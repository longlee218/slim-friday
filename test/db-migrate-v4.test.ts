import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/storage/db";
import { applyLegacySchema } from "../src/storage/legacy-schema";
import { hasTable } from "../src/storage/migrate";
import { migrateV3 } from "../src/storage/migrate-v3-turns";

// OLD NAMES ON PURPOSE: builds v2/v3 fixtures (stages, worktrees, stage_idx, after_plan, proposals.base)
// and checks the v3 -> v4 drop. Tmp dirs only.

/** Kept tables (v3 names) whose rows must survive v4 unchanged. */
const KEPT = ["turns", "runs", "approvals", "tool_calls", "proposals", "run_messages", "sessions"];

/** Rows in every table, v2 shape (old names): the same data feeds the v2 and the v3 fixture. */
const SEED = `
INSERT INTO sessions VALUES ('th1', 'sess-1', 'repo', '/r', 'active', 1);
INSERT INTO tasks (id, thread_id, source, repo, type, status, started_at, role, kind, hop, counts_toward_cap) VALUES
 ('t1', 'th1', 'discord', 'repo', 'qa', 'done', 1, 'assistant', 'single', 0, 0),
 ('t2', 'th1', 'discord', 'repo', 'code', 'running', 3, 'dev', 'staged', 0, 1);
INSERT INTO runs (id, task_id, model, cost_usd, outcome, stage_idx) VALUES ('r1', 't1', 'm', 0.25, 'success', NULL), ('r2', 't2', 'm', 0.5, 'success', 0);
INSERT INTO tool_calls (id, run_id, tool, input_json, output_preview, task_id) VALUES ('c1', 'r1', 'Read', '{}', 'a', 't1');
INSERT INTO approvals VALUES ('a1', 't2', 'Bash', 'ls', 'approved', 1, 2);
INSERT INTO stages (task_id, idx, name, status) VALUES ('t2', 0, 'plan', 'done'), ('t2', 1, 'exec', 'running');
INSERT INTO proposals (id, thread_id, workspace, from_task_id, role, brief, status, created_at, base) VALUES ('p1', 'th1', 'main', 't1', 'dev', 'b', 'started', 1, 'main');
INSERT INTO run_messages (id, thread_id, seq, kind, status, content, created_at, task_id, after_plan) VALUES ('m1', 'th1', 1, 'steer', 'pending', 'hi', 1, 't2', 1);
INSERT INTO worktrees (task_id, thread_id, repo, repo_path, path, branch, base, created_at) VALUES ('t2', 'th1', 'repo', '/r', '/w2', 'agent/t2', 'main', 1);
`;

/** Temp home with `data/agent.db` at version 2 (legacy shape + seed) or 3 (v2 plus the frozen v3 step). */
function home(version: 2 | 3, extraSql = "") {
  const dir = mkdtempSync(join(tmpdir(), "friday-v4-"));
  mkdirSync(join(dir, "data"));
  const file = join(dir, "data", "agent.db");
  const raw = new Database(file, { create: true });
  applyLegacySchema(raw);
  raw.exec(SEED);
  if (version === 3) migrateV3(raw);
  if (extraSql) raw.exec(extraSql);
  raw.close();
  return { file, backups: join(dir, "db-backups") };
}

const cols = (db: Database, t: string) =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${t})`)
    .all()
    .map((c) => c.name);
const version = (db: Database) =>
  db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()
    ?.value;
const counts = (db: Database) =>
  Object.fromEntries(
    KEPT.map((t) => [t, db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n]),
  );
const snaps = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

test("v3 db: stages/worktrees and the 3 columns are gone, kept counts equal, v4, NO snapshot", () => {
  const { file, backups } = home(3);
  const raw = new Database(file);
  const before = counts(raw);
  expect(hasTable(raw, "stages") && hasTable(raw, "worktrees")).toBe(true);
  raw.close();
  const db = openDb(file);
  expect(version(db)).toBe("4");
  expect(hasTable(db, "stages")).toBe(false);
  expect(hasTable(db, "worktrees")).toBe(false);
  expect(cols(db, "runs")).not.toContain("stage_idx");
  expect(cols(db, "run_messages")).not.toContain("after_plan");
  expect(cols(db, "proposals")).not.toContain("base");
  expect(counts(db)).toEqual(before);
  expect(before.turns).toBe(2);
  expect(db.query("SELECT cost_usd FROM runs WHERE id = 'r2'").get()).toEqual({ cost_usd: 0.5 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(snaps(backups)).toEqual([]);
});

test("v2 db: one open reaches v4 with exactly ONE friday-v2 snapshot and no friday-v3", () => {
  const { file, backups } = home(2);
  const db = openDb(file);
  expect(version(db)).toBe("4");
  expect(counts(db)).toMatchObject({ turns: 2, runs: 2, approvals: 1, proposals: 1 });
  expect(hasTable(db, "stages")).toBe(false);
  const files = snaps(backups);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^friday-v2-/);
  // The snapshot keeps the dropped data (old names).
  const snap = new Database(join(backups, files[0]!), { readonly: true });
  expect(snap.query("SELECT COUNT(*) AS n FROM stages").get()).toEqual({ n: 2 });
  snap.close();
});

test("second open is a no-op: same schema, same counts, no new snapshot", () => {
  const { file, backups } = home(2);
  const sql = (d: Database) =>
    d.query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master ORDER BY name").all();
  const first = openDb(file);
  const schema = sql(first);
  const before = counts(first);
  first.close();
  const second = openDb(file);
  expect(sql(second)).toEqual(schema);
  expect(counts(second)).toEqual(before);
  expect(snaps(backups)).toHaveLength(1);
});

test("fresh db lands on v4 without stages/worktrees and without a snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-v4-"));
  const db = openDb(join(dir, "data", "agent.db"));
  expect(version(db)).toBe("4");
  expect(hasTable(db, "stages") || hasTable(db, "worktrees")).toBe(false);
  expect(snaps(join(dir, "db-backups"))).toEqual([]);
  expect(version(openDb(":memory:"))).toBe("4");
});

/** Rollback case: the db must be exactly the v3 fixture after the failed open. */
function expectUntouchedV3(file: string, backups: string) {
  const raw = new Database(file, { readonly: true });
  expect(version(raw)).toBe("3");
  expect(hasTable(raw, "stages")).toBe(true);
  expect(hasTable(raw, "worktrees")).toBe(true);
  expect(cols(raw, "runs")).toContain("stage_idx");
  expect(cols(raw, "proposals")).toContain("base");
  expect(cols(raw, "run_messages")).toContain("after_plan");
  expect(raw.query("SELECT COUNT(*) AS n FROM stages").get()).toEqual({ n: 2 });
  raw.close();
  expect(snaps(backups)).toEqual([]);
}

test("rollback: an index on runs(stage_idx) makes DROP COLUMN throw, the db stays v3 untouched", () => {
  const { file, backups } = home(3, "CREATE INDEX idx_runs_stage_idx ON runs(stage_idx);");
  expect(() => openDb(file)).toThrow(/v4 migration failed.*stage_idx/);
  expectUntouchedV3(file, backups);
});

test("rollback: a later failure (index on proposals(base)) undoes the earlier drops too", () => {
  const { file, backups } = home(3, "CREATE INDEX idx_proposals_base ON proposals(base);");
  expect(() => openDb(file)).toThrow(/v4 migration failed/);
  // `stages`, `worktrees`, `runs.stage_idx` and `run_messages.after_plan` were already dropped in the tx.
  expectUntouchedV3(file, backups);
});
