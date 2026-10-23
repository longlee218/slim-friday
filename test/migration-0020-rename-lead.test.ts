import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/* Migration 0020 renames the role `lead`: role values become `chief-of-staff`, engine values (structure owner, event
   `by`, message author, decision event kind) become `teammate`, engine sessions are dropped. Other values stay. */

const REAL = join(import.meta.dir, "../src/storage/migrations");

test("0020: lead values are renamed, engine sessions dropped, other rows untouched", () => {
  // A migrations folder that stops at 0019 (journal cut), to create the old-shaped db.
  const old = mkdtempSync(join(tmpdir(), "mig-"));
  try {
    cpSync(REAL, old, { recursive: true });
    const jPath = join(old, "meta/_journal.json");
    const j = JSON.parse(readFileSync(jPath, "utf8")) as { entries: { idx: number }[] };
    j.entries = j.entries.filter((e) => e.idx < 20);
    writeFileSync(jPath, JSON.stringify(j));
    const db = new Database(":memory:");
    migrate(drizzle({ client: db }), { migrationsFolder: old });

    const run = (sql: string, ...args: (string | number)[]) => db.query(sql).run(...args);
    for (const [id, role] of [
      ["t1", "lead"],
      ["t2", "developer"],
    ])
      run(
        "INSERT INTO turns (id, thread_id, source, location, status, started_at, role) VALUES (?, 'th', 'discord', '*', 'done', 1, ?)",
        id as string,
        role as string,
      );
    run(
      "INSERT INTO owned_tasks (id, thread_id, status, owner_role, structure_owner, correlation_id, created_at, last_progress_at) VALUES ('g', 'th', 'open', 'lead', 'lead', 'c', 1, 1)",
    );
    run(
      "INSERT INTO owned_tasks (id, thread_id, status, owner_role, structure_owner, correlation_id, created_at, last_progress_at) VALUES ('p', 'th', 'open', 'lead', 'plan', 'c', 1, 1)",
    );
    run(
      "INSERT INTO memory_audit (ts, thread_id, channel, role, action, scope, hash) VALUES (1, 'th', 'ch', 'lead', 'save', 'channel', 'h')",
    );
    run(
      "INSERT INTO artifacts (id, workspace, title, name, kind, origin, path, size, created_at, producer_role) VALUES ('a', 'ws', 't', 'n', 'md', 'store', 'p', 1, 1, 'lead')",
    );
    for (const author of ["lead", "developer"])
      run(
        "INSERT INTO task_messages (thread_id, goal_id, task_id, author, kind, text, created_at) VALUES ('th', 'g', 'i', ?, 'brief', 'x', 1)",
        author,
      );
    run(
      `INSERT INTO thread_events (id, thread_id, kind, payload, created_at) VALUES ('e1', 'th', 'lead_decision', '{"by":"lead","tool":"Orchestrate"}', 1)`,
    );
    run(
      `INSERT INTO thread_events (id, thread_id, kind, payload, created_at) VALUES ('e2', 'th', 'answer', '{"by":"owner"}', 1)`,
    );
    for (const [thread, kind] of [
      ["s-lead", "lead"],
      ["s-role", "role"],
    ])
      run(
        "INSERT INTO sessions (thread_id, session_id, location, cwd, status, updated_at, kind) VALUES (?, 'sid', '*', '/', 'active', 1, ?)",
        thread as string,
        kind as string,
      );

    for (const [id, scope] of [
      ["f1", "lead tool call"],
      ["f2", "role"],
    ])
      run(
        "INSERT INTO effect_log (id, thread_id, tool, scope, granted_by, result, created_at) VALUES (?, 'th', 'Orchestrate', ?, 'role', 'ok', 1)",
        id as string,
        scope as string,
      );

    migrate(drizzle({ client: db }), { migrationsFolder: REAL }); // applies 0020
    const col = (sql: string) =>
      db
        .query<{ v: string }, []>(sql)
        .all()
        .map((r) => r.v);
    expect(col("SELECT role AS v FROM turns ORDER BY id")).toEqual(["chief-of-staff", "developer"]);
    expect(
      col("SELECT owner_role || '/' || structure_owner AS v FROM owned_tasks ORDER BY id"),
    ).toEqual(["chief-of-staff/teammate", "chief-of-staff/plan"]);
    expect(col("SELECT role AS v FROM memory_audit")).toEqual(["chief-of-staff"]);
    expect(col("SELECT producer_role AS v FROM artifacts")).toEqual(["chief-of-staff"]);
    expect(col("SELECT author AS v FROM task_messages ORDER BY id")).toEqual([
      "teammate",
      "developer",
    ]);
    expect(col("SELECT kind || ' ' || payload AS v FROM thread_events ORDER BY seq")).toEqual([
      'teammate_decision {"by":"teammate","tool":"Orchestrate"}',
      'answer {"by":"owner"}',
    ]);
    expect(col("SELECT thread_id AS v FROM sessions")).toEqual(["s-role"]);
    expect(col("SELECT scope AS v FROM effect_log ORDER BY id")).toEqual([
      "teammate tool call",
      "role",
    ]);
    db.close();
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});
