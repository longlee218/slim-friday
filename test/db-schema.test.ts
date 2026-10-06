import { expect, test } from "bun:test";
import {
  finishTask,
  insertRun,
  insertTask,
  insertToolCall,
  interruptRunningTasks,
  setTaskStatus,
} from "../src/storage/run-store";
import { makeEnv } from "./helpers";

test("schema has 4 tables and WAL mode", () => {
  const { db } = makeEnv();
  const names = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  for (const t of ["sessions", "tasks", "runs", "tool_calls"]) expect(names).toContain(t);
  expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe(
    "wal",
  );
});

test("task/run/tool_call helpers insert rows", () => {
  const { db } = makeEnv();
  insertTask(db, { id: "t", threadId: "th", source: "test", repo: "/r", type: "qa" });
  finishTask(db, "t", "done");
  insertRun(db, {
    id: "r",
    taskId: "t",
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
    tool: "Read",
    inputJson: "{}",
    outputPreview: "x",
    isError: false,
    durationMs: 1,
  });
  expect(db.query<{ status: string }, []>("SELECT status FROM tasks").get()?.status).toBe("done");
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM runs").get()?.n).toBe(1);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM tool_calls").get()?.n).toBe(1);
});

test("restart cleanup: waiting_approval tasks become interrupted, pending approvals cancelled", () => {
  const { db } = makeEnv();
  insertTask(db, { id: "t1", threadId: "th", source: "d", repo: "r", type: "code" });
  setTaskStatus(db, "t1", "waiting_approval");
  db.run(
    "INSERT INTO approvals (id, task_id, tool, summary, decision, requested_at) VALUES ('a','t1','Bash','s','pending',1)",
  );
  interruptRunningTasks(db);
  expect(db.query<{ status: string }, []>("SELECT status FROM tasks").get()?.status).toBe(
    "interrupted",
  );
  expect(db.query<{ decision: string }, []>("SELECT decision FROM approvals").get()?.decision).toBe(
    "cancelled",
  );
});
