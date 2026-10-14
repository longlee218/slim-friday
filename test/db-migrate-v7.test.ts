import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/storage/db";
import { applyLegacySchema } from "../src/storage/legacy-schema";
import { hasTable, KEPT_TABLES } from "../src/storage/migrate";
import { migrateV3 } from "../src/storage/migrate-v3-turns";
import { migrateV4 } from "../src/storage/migrate-v4-drop-legacy-tables";
import { migrateV5 } from "../src/storage/migrate-v5-thread-summaries";
import { migrateV6 } from "../src/storage/migrate-v6-owned-tasks";
import { migrateV7 } from "../src/storage/migrate-v7-locations-threads";

/**
 * Temp home with a real v6 db (frozen legacy schema + v3..v6 steps) holding one session, turn and proposal.
 * Rows are inserted with raw SQL on the v6 column name `repo` so the fixture does not depend on store code.
 */
function v6Home(extraSql = "") {
  const dir = mkdtempSync(join(tmpdir(), "friday-v7-"));
  mkdirSync(join(dir, "data"));
  const file = join(dir, "data", "agent.db");
  const raw = new Database(file, { create: true });
  applyLegacySchema(raw);
  raw.exec("INSERT INTO sessions VALUES ('th1', 'sess-1', 'my-repo', '/r', 'active', 1);");
  migrateV3(raw);
  migrateV4(raw);
  migrateV5(raw);
  migrateV6(raw);
  raw.exec(
    "INSERT INTO turns (id, thread_id, source, repo, type, status, started_at, role) VALUES ('t1', 'th1', 'test', 'my-repo', 'run', 'done', 1, 'dev');",
  );
  raw.exec(
    `INSERT INTO proposals (id, thread_id, workspace, from_turn_id, role, brief, repo, class, status, created_at)
     VALUES ('p1', 'th1', 'ws', 't1', 'dev', 'b', 'my-repo', 'c', 'pending', 1);`,
  );
  if (extraSql) raw.exec(extraSql);
  raw.close();
  return { file, backups: join(dir, "db-backups") };
}

const version = (db: Database) =>
  db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()
    ?.value;
const counts = (db: Database) =>
  Object.fromEntries(
    KEPT_TABLES.map((t) => [
      t,
      db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n,
    ]),
  );
const snaps = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
const columns = (db: Database, table: string) =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);

test("v6 db: columns renamed, data kept, threads + index added, ONE friday-v6 snapshot", () => {
  const { file, backups } = v6Home();
  const raw = new Database(file);
  expect(version(raw)).toBe("6");
  const before = counts(raw);
  raw.close();
  const db = openDb(file);
  expect(version(db)).toBe("7");
  expect(counts(db)).toEqual(before);
  for (const t of ["turns", "sessions", "proposals"]) {
    expect(columns(db, t)).toContain("location");
    expect(columns(db, t)).not.toContain("repo");
    expect(db.query(`SELECT location AS l FROM ${t}`).get()).toEqual({ l: "my-repo" });
  }
  expect(hasTable(db, "threads")).toBe(true);
  expect(columns(db, "threads")).toEqual([
    "thread_id",
    "channel_id",
    "workspace",
    "origin",
    "placeholder",
    "title",
    "digest",
    "created_at",
    "updated_at",
  ]);
  expect(
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'threads_channel_updated'",
      )
      .get(),
  ).toEqual({ name: "threads_channel_updated" });
  const files = snaps(backups);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^friday-v6-/);
});

test("second open is a no-op: same schema, no new snapshot", () => {
  const { file, backups } = v6Home();
  const sql = (d: Database) =>
    d.query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master ORDER BY name").all();
  const first = openDb(file);
  const schema = sql(first);
  first.close();
  expect(sql(openDb(file))).toEqual(schema);
  expect(snaps(backups)).toHaveLength(1);
});

test("rollback: a clashing threads table leaves the db at v6 with `repo` columns intact", () => {
  const { file } = v6Home("CREATE TABLE threads (x TEXT);");
  expect(() => openDb(file)).toThrow(/v7 migration failed, the db stays at v6/);
  const raw = new Database(file, { readonly: true });
  expect(version(raw)).toBe("6");
  for (const t of ["turns", "sessions", "proposals"]) {
    expect(columns(raw, t)).toContain("repo");
    expect(columns(raw, t)).not.toContain("location");
  }
  raw.close();
});

test("fresh db is v7 without snapshot; v7 step is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-v7-"));
  const db = openDb(join(dir, "data", "agent.db"));
  expect(version(db)).toBe("7");
  expect(snaps(join(dir, "db-backups"))).toEqual([]);
  expect(() => migrateV7(db)).not.toThrow();
  expect(version(db)).toBe("7");
});
