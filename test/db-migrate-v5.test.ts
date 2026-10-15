import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertApproval } from "../src/storage/approval-store";
import { openDb } from "../src/storage/db";
import { applyLegacySchema } from "../src/storage/legacy-schema";
import { hasTable } from "../src/storage/migrate";
import { migrateV3 } from "../src/storage/migrate-v3-turns";
import { migrateV4 } from "../src/storage/migrate-v4-drop-legacy-tables";
import { migrateV5, probeFts5 } from "../src/storage/migrate-v5-thread-summaries";
import { insertProposal } from "../src/storage/proposal-store";
import { insertRunMessage } from "../src/storage/run-message-store";
import { insertRun, insertToolCall } from "../src/storage/run-metrics-store";
import { insertTurn } from "../src/storage/run-store";
import { withLocationColumns } from "./legacy-turn-fixture";

// Fixtures: a real v2 db (frozen legacy schema), then the frozen v3 and v4 steps make a v4 fixture.

const KEPT = ["turns", "runs", "approvals", "tool_calls", "proposals", "run_messages", "sessions"];
const NEW_TABLES = ["thread_summaries", "memory_fts", "memory_files"];

/** Old-shape seed without old table names: a session row; the v4 fixture also gets a turn via the store. */
const SEED = `INSERT INTO sessions VALUES ('th1', 'sess-1', 'repo', '/r', 'active', 1);`;

/** Temp home with `data/agent.db` at version 2 or 4 (v2 plus the frozen v3 and v4 steps). */
function home(version: 2 | 4, extraSql = "") {
  const dir = mkdtempSync(join(tmpdir(), "friday-v5-"));
  mkdirSync(join(dir, "data"));
  const file = join(dir, "data", "agent.db");
  const raw = new Database(file, { create: true });
  applyLegacySchema(raw);
  raw.exec(SEED);
  if (version === 4) {
    migrateV3(raw);
    migrateV4(raw);
    seedEveryKeptTable(raw);
  }
  if (extraSql) raw.exec(extraSql);
  raw.close();
  return { file, backups: join(dir, "db-backups") };
}

/** One row in every kept table (v4 shape), through the real stores, so the equal-counts check means something. */
function seedEveryKeptTable(db: Database) {
  withLocationColumns(db, () => seedRows(db)); // the stores write the v7 column names
}

/** The rows of `seedEveryKeptTable`. */
function seedRows(db: Database) {
  insertTurn(db, { id: "t1", threadId: "th1", source: "test", location: "/r", role: "assistant" });
  insertRun(db, {
    id: "r1",
    turnId: "t1",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.1,
    turns: 1,
    durationMs: 1,
    outcome: "success",
    compactions: 0,
  });
  insertToolCall(db, {
    id: "c1",
    runId: "r1",
    tool: "Read",
    inputJson: "{}",
    outputPreview: "x",
    isError: false,
    durationMs: 1,
    turnId: "t1",
  });
  insertApproval(db, { id: "a1", turnId: "t1", tool: "Bash", summary: "ls" });
  insertProposal(db, { threadId: "th1", workspace: "main", role: "dev", brief: "b" });
  insertRunMessage(db, { threadId: "th1", kind: "steer", content: "hi" });
}

const version = (db: Database) =>
  db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()
    ?.value;
const counts = (db: Database) =>
  Object.fromEntries(
    KEPT.map((t) => [t, db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n]),
  );
const snaps = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

test("FTS5 probe passes on this Bun build and leaves no temp table behind", () => {
  const db = new Database(":memory:");
  expect(() => probeFts5(db)).not.toThrow();
  expect(db.query("SELECT 1 FROM sqlite_temp_master WHERE name = 'fts5_probe'").get()).toBeNull();
});

test("fresh db is v5 with the new tables; accented text matches an unaccented query", () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-v5-"));
  const db = openDb(join(dir, "data", "agent.db"));
  expect(version(db)).toBe("8");
  for (const t of NEW_TABLES) expect(hasTable(db, t)).toBe(true);
  db.query("INSERT INTO memory_fts (text, id, workspace) VALUES (?, 'c1', 'main')").run(
    "Café résumé of the plan",
  );
  const hit = db
    .query<{ id: string }, [string]>("SELECT id FROM memory_fts WHERE memory_fts MATCH ?")
    .get("cafe");
  expect(hit?.id).toBe("c1");
  expect(snaps(join(dir, "db-backups"))).toEqual([]);
  expect(version(openDb(":memory:"))).toBe("8");
});

test("v4 db: kept counts equal, new tables exist, v5, NO snapshot", () => {
  const { file, backups } = home(4);
  const raw = new Database(file);
  expect(version(raw)).toBe("4");
  const before = counts(raw);
  raw.close();
  const db = openDb(file);
  expect(version(db)).toBe("8");
  expect(counts(db)).toEqual(before);
  for (const t of KEPT) expect(before[t]).toBeGreaterThan(0);
  for (const t of NEW_TABLES) expect(hasTable(db, t)).toBe(true);
  expect(snaps(backups)).toEqual([]);
});

test("v2 db chains to v5 with exactly ONE friday-v2 snapshot", () => {
  const { file, backups } = home(2);
  const db = openDb(file);
  expect(version(db)).toBe("8");
  expect(hasTable(db, "thread_summaries")).toBe(true);
  const files = snaps(backups);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^friday-v2-/);
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

test("rollback: a clash on memory_files (after the FTS DDL ran) leaves the db at v4", () => {
  const { file, backups } = home(4, "CREATE TABLE memory_files (x TEXT);");
  expect(() => openDb(file)).toThrow(/v5 migration failed, the db stays at v4/);
  const raw = new Database(file, { readonly: true });
  expect(version(raw)).toBe("4");
  expect(hasTable(raw, "thread_summaries")).toBe(false);
  expect(hasTable(raw, "memory_fts")).toBe(false); // the virtual table was rolled back too
  raw.close();
  expect(snaps(backups)).toEqual([]);
});

test("FTS5 probe failure throws the clear error and the db stays v4", () => {
  const { file } = home(4);
  const raw = new Database(file);
  const failing = () => {
    throw new Error("no such module: fts5");
  };
  expect(() => migrateV5(raw, failing)).toThrow(/v5 migration failed, the db stays at v4.*fts5/);
  expect(version(raw)).toBe("4");
  expect(hasTable(raw, "thread_summaries")).toBe(false);
  raw.close();
});

test("a v4 binary gate (>= 4 returns early) accepts a v5 db", () => {
  const db = openDb(":memory:");
  expect(() => migrateV4(db)).not.toThrow();
  expect(version(db)).toBe("8");
});
