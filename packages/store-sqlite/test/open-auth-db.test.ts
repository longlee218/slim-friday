import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineStore } from "../src/engine-store";
import { openAuthDb } from "../src/open-auth-db";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "auth-db-")), "engine.db");
const tableNames = (file: string) => {
  const raw = new Database(file, { readonly: true });
  const names = raw
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  raw.close();
  return names;
};

test("opening creates the five auth tables next to the engine tables", () => {
  const f = tmpFile();
  openAuthDb(f).close();
  const names = tableNames(f);
  for (const t of [
    "auth_user",
    "auth_session",
    "auth_account",
    "auth_verification",
    "auth_passkey",
  ])
    expect(names).toContain(t);
  for (const t of ["conversations", "messages", "sessions", "wakes"]) expect(names).toContain(t);
});

/** Rows in the migration log of the db file. */
const logCount = (file: string) => {
  const raw = new Database(file, { readonly: true });
  const row = raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM __drizzle_migrations").get();
  raw.close();
  return row?.n ?? 0;
};

test("the engine store opens the same file afterwards with one migration log", () => {
  const f = tmpFile();
  openAuthDb(f).close();
  const before = logCount(f);
  openEngineStore(f).close();
  expect(before).toBeGreaterThan(0);
  expect(logCount(f)).toBe(before);
});

test(":memory: opens and answers ping", () => {
  const a = openAuthDb(":memory:");
  expect(a.ping()).toBe(true);
  a.close();
});

test("ping is true while open, false (no throw) after close", () => {
  const a = openAuthDb(tmpFile());
  expect(a.ping()).toBe(true);
  a.close();
  expect(a.ping()).toBe(false);
});

test("exposes the schema keyed by better-auth model names", () => {
  const a = openAuthDb(":memory:");
  expect(Object.keys(a.schema).sort()).toEqual([
    "account",
    "passkey",
    "session",
    "user",
    "verification",
  ]);
  a.close();
});
