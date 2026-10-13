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
import { insertTurn } from "../src/storage/run-store";

/** Temp home with a real v5 db (frozen legacy schema + v3, v4, v5 steps) holding one turn. */
function v5Home(extraSql = "") {
  const dir = mkdtempSync(join(tmpdir(), "friday-v6-"));
  mkdirSync(join(dir, "data"));
  const file = join(dir, "data", "agent.db");
  const raw = new Database(file, { create: true });
  applyLegacySchema(raw);
  raw.exec("INSERT INTO sessions VALUES ('th1', 'sess-1', 'repo', '/r', 'active', 1);");
  migrateV3(raw);
  migrateV4(raw);
  migrateV5(raw);
  insertTurn(raw, { id: "t1", threadId: "th1", source: "test", repo: "/r", role: "dev" });
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
const turnColumns = (db: Database) =>
  db
    .query<{ name: string }, []>("PRAGMA table_info(turns)")
    .all()
    .map((c) => c.name);

test("fresh db is v6: owned_tasks + turns.owned_task_id, no snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-v6-"));
  const db = openDb(join(dir, "data", "agent.db"));
  expect(version(db)).toBe("6");
  expect(hasTable(db, "owned_tasks")).toBe(true);
  expect(turnColumns(db)).toContain("owned_task_id");
  expect(snaps(join(dir, "db-backups"))).toEqual([]);
  expect(version(openDb(":memory:"))).toBe("6");
});

test("v5 db: kept counts equal, table + column added, ONE friday-v5 snapshot, old turn unlinked", () => {
  const { file, backups } = v5Home();
  const raw = new Database(file);
  expect(version(raw)).toBe("5");
  const before = counts(raw);
  raw.close();
  const db = openDb(file);
  expect(version(db)).toBe("6");
  expect(counts(db)).toEqual(before);
  expect(before.turns).toBe(1);
  expect(hasTable(db, "owned_tasks")).toBe(true);
  expect(db.query("SELECT owned_task_id AS id FROM turns WHERE id = 't1'").get()).toEqual({
    id: null,
  });
  const files = snaps(backups);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^friday-v5-/);
});

test("second open is a no-op: same schema, no new snapshot", () => {
  const { file, backups } = v5Home();
  const sql = (d: Database) =>
    d.query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master ORDER BY name").all();
  const first = openDb(file);
  const schema = sql(first);
  first.close();
  expect(sql(openDb(file))).toEqual(schema);
  expect(snaps(backups)).toHaveLength(1);
});

test("rollback: a clashing owned_tasks table leaves the db at v5 and without the new column", () => {
  const { file } = v5Home("CREATE TABLE owned_tasks (x TEXT);");
  expect(() => openDb(file)).toThrow(/v6 migration failed, the db stays at v5/);
  const raw = new Database(file, { readonly: true });
  expect(version(raw)).toBe("5");
  expect(turnColumns(raw)).not.toContain("owned_task_id");
  raw.close();
});

test("a v5 binary gate (>= 5 returns early) accepts a v6 db; v6 step is idempotent", () => {
  const db = openDb(":memory:");
  expect(() => migrateV5(db)).not.toThrow();
  expect(() => migrateV6(db)).not.toThrow();
  expect(version(db)).toBe("6");
});
