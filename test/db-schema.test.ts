import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/storage/db";
import { insertRun, insertToolCall } from "../src/storage/run-metrics-store";
import {
  finishTurn,
  insertTurn,
  interruptRunningTurns,
  setTurnStatus,
} from "../src/storage/run-store";
import { BASH_TOOL_NAME, READ_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { makeEnv } from "./helpers";

test("schema has 4 tables and WAL mode", () => {
  const { db } = makeEnv();
  const names = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  for (const t of ["sessions", "turns", "runs", "tool_calls"]) expect(names).toContain(t);
  expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe(
    "wal",
  );
});

test("task/run/tool_call helpers insert rows", () => {
  const { db } = makeEnv();
  insertTurn(db, { id: "t", threadId: "th", source: "test", location: "/r", role: "lead" });
  finishTurn(db, "t", "done");
  insertRun(db, {
    id: "r",
    turnId: "t",
    model: "m",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheCreationTokens: 4,
    costUsd: 0.1,
    turns: 1,
    durationMs: 5,
    outcome: "success",
    compactions: 0,
  });
  insertToolCall(db, {
    id: "c",
    runId: "r",
    tool: READ_TOOL_NAME,
    inputJson: "{}",
    outputPreview: "x",
    isError: false,
    durationMs: 1,
  });
  expect(db.query<{ status: string }, []>("SELECT status FROM turns").get()?.status).toBe("done");
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM runs").get()?.n).toBe(1);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM tool_calls").get()?.n).toBe(1);
});

test("restart cleanup: waiting_approval tasks become interrupted, pending approvals cancelled", () => {
  const { db } = makeEnv();
  insertTurn(db, { id: "t1", threadId: "th", source: "d", location: "r", role: "dev" });
  setTurnStatus(db, "t1", "waiting_approval");
  db.run(
    "INSERT INTO approvals (id, turn_id, tool, summary, decision, requested_at) VALUES ('a','t1',?,'s','pending',1)",
    [BASH_TOOL_NAME],
  );
  interruptRunningTurns(db);
  expect(db.query<{ status: string }, []>("SELECT status FROM turns").get()?.status).toBe(
    "interrupted",
  );
  expect(db.query<{ decision: string }, []>("SELECT decision FROM approvals").get()?.decision).toBe(
    "cancelled",
  );
});

test("migration: old db without brief column gets brief added via ALTER TABLE", () => {
  const path = join(tmpdir(), `test-db-migrate-${Date.now()}.sqlite`);
  try {
    // Create old (pre-v3) database without brief column: the fixture DDL keeps the old names on purpose
    const oldDb = new Database(path, { create: true });
    oldDb.run("PRAGMA journal_mode = WAL");
    oldDb.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        source TEXT NOT NULL,
        repo TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        session_id TEXT,
        session_cwd TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL,
        compactions INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_preview TEXT NOT NULL,
        is_error INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        summary TEXT NOT NULL,
        decision TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        decided_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS worktrees (
        task_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base TEXT NOT NULL,
        pr_url TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worktrees_thread ON worktrees(thread_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id);
      CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id);
    `);
    // Add old data
    oldDb.run(
      "INSERT INTO tasks (id, thread_id, source, repo, type, status, started_at) VALUES ('t1', 'th1', 'test', 'r1', 'code', 'done', 123456)",
    );
    oldDb.close();

    // Now open with new code that expects brief column
    const newDb = openDb(path);

    // Verify the column was added
    const columns = newDb
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .map((c) => c.name);
    expect(columns).toContain("brief");

    // Verify old data still exists
    const row = newDb
      .query<{ id: string; brief: string | null }, []>("SELECT id, brief FROM turns")
      .get();
    expect(row?.id).toBe("t1");
    expect(row?.brief).toBeNull();

    // Verify we can insert a task with brief
    insertTurn(newDb, {
      id: "t2",
      threadId: "th1",
      source: "test",
      location: "r1",
      role: "dev",
      brief: "test brief",
    });
    const newRow = newDb
      .query<{ id: string; brief: string | null }, [string]>(
        "SELECT id, brief FROM turns WHERE id = ?",
      )
      .get("t2");
    expect(newRow?.id).toBe("t2");
    expect(newRow?.brief).toBeTruthy();
    expect(newRow?.brief).toContain("test brief");

    newDb.close();
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});
