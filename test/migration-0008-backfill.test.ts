import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/* Migration 0008 adds `priority` (default 0) and `subject` to owned_tasks and backfills the subject of item rows from
   the first 80 chars of their brief (one line); goals and rows with no brief keep a null subject. */

const REAL = join(import.meta.dir, "../src/storage/migrations");

test("0008: priority defaults to 0, item subjects come from the brief, goals stay null", () => {
  const old = mkdtempSync(join(tmpdir(), "mig-"));
  try {
    cpSync(REAL, old, { recursive: true });
    const jPath = join(old, "meta/_journal.json");
    const j = JSON.parse(readFileSync(jPath, "utf8")) as { entries: { idx: number }[] };
    j.entries = j.entries.filter((e) => e.idx < 8); // the db as it was before 0008
    writeFileSync(jPath, JSON.stringify(j));
    const db = new Database(":memory:");
    migrate(drizzle({ client: db }), { migrationsFolder: old });
    const row = (id: string, parent: string | null, brief: string | null) =>
      db
        .query(
          "INSERT INTO owned_tasks (id, thread_id, status, correlation_id, created_at, last_progress_at, parent_id, item_key, brief) VALUES (?, 't', 'ready', 'c', 1, 1, ?, ?, ?)",
        )
        .run(id, parent, parent ? id : null, brief);
    row("goal", null, null);
    row("long", "goal", `Line one\n${"x".repeat(200)}`);
    row("none", "goal", null);

    migrate(drizzle({ client: db }), { migrationsFolder: REAL }); // applies 0008
    const get = (id: string) =>
      db
        .query<{ s: string | null; p: number }, [string]>(
          "SELECT subject AS s, priority AS p FROM owned_tasks WHERE id = ?",
        )
        .get(id);
    expect(get("goal")).toEqual({ s: null, p: 0 });
    expect(get("none")).toEqual({ s: null, p: 0 });
    const long = get("long");
    expect(long?.p).toBe(0);
    expect(long?.s?.startsWith("Line one xxx")).toBe(true); // newline folded
    expect(long?.s).toHaveLength(80);
    db.close();
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});
