import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/storage/db";
import { applyLegacySchema } from "../src/storage/legacy-schema";
import { hasTable } from "../src/storage/migrate";

// OLD NAMES ON PURPOSE: a v2 db that lacks later additive columns must get them back, then be renamed to v3 and cleaned by v4.
// Tmp dir only.

const cols = (db: Database, table: string) =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);

test("v2 db missing proposals.effort and worktrees.files_*: legacy step re-adds them, then v3 rename and the v4 drop run", () => {
  const home = mkdtempSync(join(tmpdir(), "friday-v3-cols-"));
  mkdirSync(join(home, "data"));
  const file = join(home, "data", "agent.db");
  const raw = new Database(file, { create: true });
  applyLegacySchema(raw);
  raw.exec("ALTER TABLE proposals DROP COLUMN effort");
  raw.exec("ALTER TABLE worktrees DROP COLUMN files_changed");
  raw.exec("ALTER TABLE worktrees DROP COLUMN files_top");
  expect(cols(raw, "proposals")).not.toContain("effort");
  expect(cols(raw, "worktrees")).not.toContain("files_top");
  // The frozen legacy step re-adds the missing columns (checked before v3/v4 run).
  applyLegacySchema(raw);
  expect(cols(raw, "worktrees")).toEqual(expect.arrayContaining(["files_changed", "files_top"]));
  raw.exec("ALTER TABLE worktrees DROP COLUMN files_top");
  raw.close();

  const db = openDb(file);
  expect(cols(db, "proposals")).toContain("effort");
  expect(hasTable(db, "worktrees")).toBe(false); // dropped by v4
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  expect(tables).toContain("turns");
  expect(tables).not.toContain("tasks");
  expect(
    db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()
      ?.value,
  ).toBe("7");
  const snaps = readdirSync(join(home, "db-backups"));
  expect(snaps).toHaveLength(1);
  expect(snaps[0]).toMatch(/^friday-v2-/);
});
