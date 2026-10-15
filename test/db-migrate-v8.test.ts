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
import { migrateV8 } from "../src/storage/migrate-v8-lead-orchestration";

/** Temp home with a real v7 db (legacy schema + v3..v7 steps) holding a session, a turn, a proposal and an owned task. */
function v7Home(extraSql = "") {
  const dir = mkdtempSync(join(tmpdir(), "friday-v8-"));
  mkdirSync(join(dir, "data"));
  const file = join(dir, "data", "agent.db");
  const raw = new Database(file, { create: true });
  applyLegacySchema(raw);
  raw.exec("INSERT INTO sessions VALUES ('th1', 'sess-1', 'my-repo', '/r', 'active', 1);");
  for (const step of [migrateV3, migrateV4, migrateV5, migrateV6, migrateV7]) step(raw);
  raw.exec(
    "INSERT INTO turns (id, thread_id, source, location, type, status, started_at, role) VALUES ('t1', 'th1', 'test', 'my-repo', 'run', 'done', 1, 'developer');",
  );
  raw.exec(
    `INSERT INTO owned_tasks (id, thread_id, owner_role, status, scope, correlation_id, created_at, last_progress_at)
     VALUES ('o1', 'th1', 'developer', 'completed', 's', 'c', 1, 1);`,
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

test("v7 db: counts kept, new columns + tables added, old rows get defaults, ONE friday-v7 snapshot", () => {
  const { file, backups } = v7Home();
  const raw = new Database(file);
  expect(version(raw)).toBe("7");
  const before = counts(raw);
  raw.close();
  const db = openDb(file);
  expect(version(db)).toBe("8");
  expect(counts(db)).toEqual(before);
  expect(columns(db, "owned_tasks")).toEqual(
    expect.arrayContaining([
      "parent_id",
      "item_key",
      "depends_on",
      "dispatch_count",
      "result_path",
    ]),
  );
  expect(columns(db, "sessions")).toEqual(expect.arrayContaining(["model", "generation", "kind"]));
  expect(
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'owned_tasks_goal_item'",
      )
      .get(),
  ).toEqual({ name: "owned_tasks_goal_item" });
  for (const t of ["work_plans", "thread_events", "effect_log"]) expect(hasTable(db, t)).toBe(true);
  expect(
    db.query("SELECT depends_on AS d, attempt AS a, parent_id AS p FROM owned_tasks").get(),
  ).toEqual({ d: "[]", a: 0, p: null });
  expect(db.query("SELECT generation AS g, kind AS k FROM sessions").get()).toEqual({
    g: 0,
    k: "role",
  });
  const files = snaps(backups);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^friday-v7-/);
});

test("rollback: a clashing effect_log table leaves the db at v7 with no new column", () => {
  const { file } = v7Home("CREATE TABLE effect_log (x TEXT);");
  expect(() => openDb(file)).toThrow(/v8 migration failed, the db stays at v7/);
  const raw = new Database(file, { readonly: true });
  expect(version(raw)).toBe("7");
  expect(columns(raw, "owned_tasks")).not.toContain("parent_id");
  expect(columns(raw, "sessions")).not.toContain("generation");
  expect(hasTable(raw, "work_plans")).toBe(false);
  raw.close();
});

test("re-run is a no-op: same schema, no new snapshot", () => {
  const { file, backups } = v7Home();
  const sql = (d: Database) =>
    d.query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master ORDER BY name").all();
  const first = openDb(file);
  const schema = sql(first);
  first.close();
  const second = openDb(file);
  expect(sql(second)).toEqual(schema);
  expect(() => migrateV8(second)).not.toThrow();
  expect(snaps(backups)).toHaveLength(1);
});

test("fresh db is v8 without snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-v8-"));
  const db = openDb(join(dir, "data", "agent.db"));
  expect(version(db)).toBe("8");
  expect(snaps(join(dir, "db-backups"))).toEqual([]);
});
