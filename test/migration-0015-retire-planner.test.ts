import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/* Migration 0015 retires the planner: structure_owner `planner` becomes `plan`, and the open items of the planner role
   are cancelled (their runs are gone); finished ones and other roles keep their status. */

const REAL = join(import.meta.dir, "../src/storage/migrations");

test("0015: planner-owned goals become plan-owned, open planner items are cancelled, nothing else changes", () => {
  // A migrations folder that stops at 0014 (journal cut), to create the old-shaped db.
  const old = mkdtempSync(join(tmpdir(), "mig-"));
  try {
    cpSync(REAL, old, { recursive: true });
    const jPath = join(old, "meta/_journal.json");
    const j = JSON.parse(readFileSync(jPath, "utf8")) as { entries: { idx: number }[] };
    j.entries = j.entries.filter((e) => e.idx < 15);
    writeFileSync(jPath, JSON.stringify(j));
    const db = new Database(":memory:");
    migrate(drizzle({ client: db }), { migrationsFolder: old });

    const row = (id: string, status: string, role: string | null, owner: string | null) =>
      db
        .query(
          "INSERT INTO owned_tasks (id, thread_id, status, owner_role, structure_owner, correlation_id, created_at, last_progress_at) VALUES (?, 't', ?, ?, ?, 'c', 1, 1)",
        )
        .run(id, status, role, owner);
    row("g-planner", "open", "lead", "planner");
    row("g-lead", "open", "lead", "lead");
    row("p-running", "running", "planner", null);
    row("p-done", "completed", "planner", null);
    row("d-running", "running", "developer", null);

    migrate(drizzle({ client: db }), { migrationsFolder: REAL }); // applies 0015
    const get = (id: string) =>
      db
        .query<{ s: string; o: string | null }, [string]>(
          "SELECT status AS s, structure_owner AS o FROM owned_tasks WHERE id = ?",
        )
        .get(id);
    expect(get("g-planner")).toEqual({ s: "open", o: "plan" });
    expect(get("g-lead")).toEqual({ s: "open", o: "lead" });
    expect(get("p-running")?.s).toBe("cancelled");
    expect(get("p-done")?.s).toBe("completed");
    expect(get("d-running")?.s).toBe("running");
    db.close();
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});
