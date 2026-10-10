import { expect, test } from "bun:test";
import { CREATE_PR_APPROVAL } from "../src/orchestrator/engine/gates";
import { deriveThreadState, isIdleLike } from "../src/orchestrator/thread/thread-state";
import { insertApproval } from "../src/storage/approval-store";
import { finishTask, insertTask, setTaskStatus } from "../src/storage/run-store";
import { upsertStage } from "../src/storage/stage-store";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { makeEnv } from "./helpers";

/** One thread, one code task in `status`. */
function task(status: Parameters<typeof setTaskStatus>[2], type = "code") {
  const { db } = makeEnv();
  insertTask(db, { id: "t1", threadId: "th", source: "t", repo: "r", type });
  setTaskStatus(db, "t1", status);
  return db;
}

const pending = (db: ReturnType<typeof makeEnv>["db"], tool: string, id = "ap1") =>
  insertApproval(db, { id, taskId: "t1", tool, summary: "s" });

test("idle: no task", () => {
  expect(deriveThreadState(makeEnv().db, "th")).toBe("idle");
});

test("idle: the last task was cancelled, failed, timed out or interrupted", () => {
  for (const s of ["cancelled", "failed", "timeout", "interrupted"] as const)
    expect(deriveThreadState(task(s), "th")).toBe("idle");
});

test("running: task running (Q&A or code)", () => {
  expect(deriveThreadState(task("running"), "th")).toBe("running");
  expect(deriveThreadState(task("running", "qa"), "th")).toBe("running");
});

test("awaiting_plan_approval: waiting on the plan gate", () => {
  const db = task("waiting_approval");
  pending(db, EXIT_PLAN_MODE_TOOL_NAME);
  expect(deriveThreadState(db, "th")).toBe("awaiting_plan_approval");
});

test("awaiting_result: waiting on the delivery gate", () => {
  const db = task("waiting_approval");
  pending(db, CREATE_PR_APPROVAL);
  expect(deriveThreadState(db, "th")).toBe("awaiting_result");
});

test("running: waiting for a tool approval or an answer is not a gate", () => {
  const db = task("waiting_approval");
  pending(db, "Bash");
  expect(deriveThreadState(db, "th")).toBe("running");
});

test("gate recognized by the running stage when no approval row is pending", () => {
  const plan = task("waiting_approval");
  upsertStage(plan, { taskId: "t1", idx: 0, name: "plan", status: "running" });
  expect(deriveThreadState(plan, "th")).toBe("awaiting_plan_approval");
  const exec = task("waiting_approval");
  upsertStage(exec, { taskId: "t1", idx: 1, name: "exec", status: "running" });
  expect(deriveThreadState(exec, "th")).toBe("awaiting_result");
  expect(deriveThreadState(task("waiting_approval"), "th")).toBe("running"); // no hint at all
});

test("done folds to idle", () => {
  const db = task("running");
  finishTask(db, "t1", "done");
  expect(deriveThreadState(db, "th")).toBe("done");
  expect(isIdleLike("done")).toBe(true);
  expect(isIdleLike("idle")).toBe(true);
  expect(isIdleLike("running")).toBe(false);
  expect(isIdleLike("awaiting_plan_approval")).toBe(false);
  expect(isIdleLike("awaiting_result")).toBe(false);
});

test("the newest task decides; other threads are ignored", () => {
  const db = task("done");
  insertTask(db, { id: "t2", threadId: "th", source: "t", repo: "r", type: "code" });
  expect(deriveThreadState(db, "th")).toBe("running");
  expect(deriveThreadState(db, "other")).toBe("idle");
});

test("a task row of an unknown role is idle-like, not a crash", () => {
  const db = task("waiting_approval");
  db.query("UPDATE tasks SET role = 'ghost-role' WHERE id = 't1'").run();
  upsertStage(db, { taskId: "t1", idx: 0, name: "x", status: "running" });
  expect(deriveThreadState(db, "th")).toBe("idle");
});
