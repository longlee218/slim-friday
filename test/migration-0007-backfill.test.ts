import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/* Migration 0007 backfills structure_owner of goals that exist before it: a goal with a plan OR a planner item
   (any status, plan not written yet) is planner-owned, every other goal lead-owned. */

const REAL = join(import.meta.dir, "../src/storage/migrations");

test("0007 backfill: goal with plan = planner, goal with a planner item and no plan = planner, plain goal = lead", () => {
  // A migrations folder that stops at 0006 (journal cut), to build the old-shaped db.
  const old = mkdtempSync(join(tmpdir(), "mig-"));
  try {
    cpSync(REAL, old, { recursive: true });
    const jPath = join(old, "meta/_journal.json");
    const j = JSON.parse(readFileSync(jPath, "utf8")) as { entries: { idx: number }[] };
    j.entries = j.entries.filter((e) => e.idx < 7);
    writeFileSync(jPath, JSON.stringify(j));
    const db = new Database(":memory:");
    migrate(drizzle({ client: db }), { migrationsFolder: old });

    const goal = (id: string) =>
      db
        .query(
          "INSERT INTO owned_tasks (id, thread_id, status, correlation_id, created_at, last_progress_at) VALUES (?, 't', 'open', 'c', 1, 1)",
        )
        .run(id);
    for (const g of ["gPlan", "gPlanner", "gPlain"]) goal(g);
    db.query(
      "INSERT INTO work_plans (id, version, goal_id, status, strategy, objective, body, created_at) VALUES ('p', 1, 'gPlan', 'valid', 'PLAN', 'o', '{}', 1)",
    ).run();
    db.query(
      "INSERT INTO owned_tasks (id, thread_id, status, correlation_id, created_at, last_progress_at, parent_id, item_key) VALUES ('i1', 't', 'running', 'c', 1, 1, 'gPlanner', 'planner')",
    ).run();
    db.query(
      "INSERT INTO owned_tasks (id, thread_id, status, correlation_id, created_at, last_progress_at, parent_id, item_key) VALUES ('i2', 't', 'running', 'c', 1, 1, 'gPlain', 'm')",
    ).run();

    migrate(drizzle({ client: db }), { migrationsFolder: REAL }); // applies 0007
    const owner = (id: string) =>
      db
        .query<{ o: string | null }, [string]>(
          "SELECT structure_owner AS o FROM owned_tasks WHERE id = ?",
        )
        .get(id)?.o;
    expect([owner("gPlan"), owner("gPlanner"), owner("gPlain")]).toEqual(["plan", "plan", "lead"]);
    expect(owner("i1")).toBeNull(); // item rows stay null
    db.close();
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});
