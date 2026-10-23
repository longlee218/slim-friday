import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DB_RETENTION_DAYS } from "../src/config/resilience-caps";
import { sweepDb } from "../src/lifecycle/db-retention-sweeper";
import { makeEnv } from "./helpers";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-22T12:00:00Z");
const OLD = NOW - (DB_RETENTION_DAYS + 1) * DAY_MS;
const NEW = NOW - DAY_MS;

/** A turn with one run and one tool call; `ended` null = still running. */
function turn(
  db: Database,
  id: string,
  ended: number | null,
  startedAt: number,
  taskId: string | null = null,
) {
  db.query(
    `INSERT INTO turns (id, thread_id, source, location, status, started_at, ended_at, role, owned_task_id)
     VALUES (?, 't', 'owner', '*', ?, ?, ?, 'developer', ?)`,
  ).run(id, ended == null ? "running" : "done", startedAt, ended, taskId);
  db.query("INSERT INTO runs (id, turn_id, model, outcome) VALUES (?, ?, 'm', 'success')").run(
    `r-${id}`,
    id,
  );
  db.query(
    "INSERT INTO tool_calls (id, run_id, tool, input_json, output_preview, turn_id) VALUES (?, ?, 'Read', '{}', '', ?)",
  ).run(`c-${id}`, `r-${id}`, id);
}

/** An owned_tasks row: a goal (no parent) or an item of `parent`. */
function task(db: Database, id: string, status: string, at: number, parent: string | null = null) {
  db.query(
    `INSERT INTO owned_tasks (id, thread_id, owner_role, status, correlation_id, created_at, last_progress_at, parent_id)
     VALUES (?, 't', 'lead', ?, 'c', ?, ?, ?)`,
  ).run(id, status, at, at, parent);
}

function event(db: Database, id: string, at: number, delivered: number | null) {
  db.query(
    "INSERT INTO thread_events (id, thread_id, kind, payload, created_at, delivered_at) VALUES (?, 't', 'progress', '{}', ?, ?)",
  ).run(id, at, delivered);
}

function ids(db: Database, table: string, col = "id"): string[] {
  return db
    .query<{ v: string }, []>(`SELECT ${col} AS v FROM ${table} ORDER BY ${col}`)
    .all()
    .map((r) => r.v);
}

test("old finished history goes; recent rows and work in progress stay", () => {
  const { db } = makeEnv();
  // Goals: an old closed one (with its item) goes; an old closed one with an open item, and a recent one, stay.
  task(db, "g-old", "completed", OLD);
  task(db, "i-old", "completed", OLD, "g-old");
  task(db, "g-held", "completed", OLD);
  task(db, "i-held", "blocked", OLD, "g-held");
  task(db, "g-new", "completed", NEW);
  // Turns: old ended goes; old ended of an open item, old running and recent ended stay.
  turn(db, "old", OLD, OLD);
  turn(db, "held", OLD, OLD, "i-held");
  turn(db, "running", null, OLD);
  turn(db, "new", NEW, NEW);
  event(db, "e-old", OLD, OLD);
  event(db, "e-undelivered", OLD, null);
  event(db, "e-new", NEW, NEW);

  // Messages: those of the old closed goal (and their index rows) go; those of the goal with an open item stay.
  for (const [goal, item] of [
    ["g-old", "i-old"],
    ["g-held", "i-held"],
  ] as const) {
    const id = Number(
      db
        .query(
          `INSERT INTO task_messages (thread_id, goal_id, task_id, author, kind, text, created_at)
           VALUES ('t', ?, ?, 'lead', 'brief', 'x', ?)`,
        )
        .run(goal, item, OLD).lastInsertRowid,
    );
    db.query(
      "INSERT INTO task_messages_fts (text, message_id, thread_id, chunk, orig) VALUES ('x', ?, 't', 0, 'x')",
    ).run(id);
  }

  const counts = sweepDb(db, NOW);

  expect(ids(db, "task_messages", "task_id")).toEqual(["i-held"]);
  expect(db.query("SELECT COUNT(*) AS n FROM task_messages_fts").get()).toEqual({ n: 1 });
  expect(counts).toMatchObject({ task_messages: 1 });
  expect(ids(db, "turns")).toEqual(["held", "new", "running"]);
  expect(ids(db, "runs")).toEqual(["r-held", "r-new", "r-running"]);
  expect(ids(db, "tool_calls")).toEqual(["c-held", "c-new", "c-running"]);
  expect(ids(db, "owned_tasks")).toEqual(["g-held", "g-new", "i-held"]);
  expect(ids(db, "thread_events")).toEqual(["e-new", "e-undelivered"]);
  expect(counts).toMatchObject({
    turns: 1,
    runs: 1,
    tool_calls: 1,
    owned_tasks: 2,
    thread_events: 1,
  });
});

test("a second sweep deletes nothing", () => {
  const { db } = makeEnv();
  turn(db, "old", OLD, OLD);
  sweepDb(db, NOW);
  expect(Object.values(sweepDb(db, NOW)).every((n) => n === 0)).toBe(true);
});

test("the task-files copies of a pruned goal go with its messages; the others stay", () => {
  const { db, home, paths } = makeEnv();
  task(db, "g-old", "completed", OLD);
  task(db, "i-old", "completed", OLD, "g-old");
  task(db, "g-held", "completed", OLD);
  task(db, "i-held", "blocked", OLD, "g-held");
  for (const [g, i] of [
    ["g-old", "i-old"],
    ["g-held", "i-held"],
  ] as const) {
    mkdirSync(paths.taskFilesOf(g, i), { recursive: true });
    writeFileSync(join(paths.taskFilesOf(g, i), "1-a.md"), "copy");
  }
  sweepDb(db, NOW, home);
  expect(readdirSync(paths.taskFiles)).toEqual(["g-held"]);
});
