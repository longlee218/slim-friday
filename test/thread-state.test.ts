import { expect, test } from "bun:test";
import {
  deriveThreadState,
  isGateState,
  isIdleLike,
  pendingToolApproval,
} from "../src/orchestrator/thread/thread-state";
import { insertApproval } from "../src/storage/approval-store";
import {
  finishTurn,
  insertTurn,
  interruptRunningTurns,
  listInterruptedThreads,
  setTurnStatus,
} from "../src/storage/run-store";
import { upsertStage } from "../src/storage/stage-store";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { makeEnv } from "./helpers";

/** One thread, one code task in `status`. */
function task(status: Parameters<typeof setTurnStatus>[2], role = "dev") {
  const { db } = makeEnv();
  insertTurn(db, { id: "t1", threadId: "th", source: "t", repo: "r", role });
  setTurnStatus(db, "t1", status);
  return db;
}

const pending = (db: ReturnType<typeof makeEnv>["db"], tool: string, id = "ap1") =>
  insertApproval(db, { id, turnId: "t1", tool, summary: "s" });

test("idle: no task", () => {
  expect(deriveThreadState(makeEnv().db, "th")).toBe("idle");
});

test("idle: the last task was cancelled, failed, timed out or interrupted", () => {
  for (const s of ["cancelled", "failed", "timeout", "interrupted"] as const)
    expect(deriveThreadState(task(s), "th")).toBe("idle");
});

test("running: task running (Q&A or code)", () => {
  expect(deriveThreadState(task("running"), "th")).toBe("running");
  expect(deriveThreadState(task("running", "assistant"), "th")).toBe("running");
});

test("awaiting_plan_approval: waiting on the plan gate", () => {
  const db = task("waiting_approval");
  pending(db, EXIT_PLAN_MODE_TOOL_NAME);
  expect(deriveThreadState(db, "th")).toBe("awaiting_plan_approval");
});

test("no delivery gate any more: a pending approval labelled CreatePR (old row) is a plain tool approval", () => {
  const db = task("waiting_approval");
  pending(db, "CreatePR");
  expect(deriveThreadState(db, "th")).toBe("awaiting_tool_approval");
});

test("awaiting_tool_approval: a pending tool approval is not a gate; the decision lands -> running again", () => {
  const db = task("waiting_approval");
  pending(db, "Bash");
  expect(deriveThreadState(db, "th")).toBe("awaiting_tool_approval");
  expect(isGateState("awaiting_tool_approval")).toBe(false);
  expect(isIdleLike("awaiting_tool_approval")).toBe(false);
  expect(pendingToolApproval(db, "t1")?.tool).toBe("Bash");
  db.query("UPDATE approvals SET decision = 'approved'").run();
  db.query("UPDATE turns SET status = 'running'").run();
  expect(deriveThreadState(db, "th")).toBe("running");
  expect(pendingToolApproval(db, "t1")).toBeUndefined();
});

test("a gate approval is never a tool approval", () => {
  const db = task("waiting_approval");
  pending(db, EXIT_PLAN_MODE_TOOL_NAME);
  expect(pendingToolApproval(db, "t1")).toBeUndefined();
});

test("failed_resumable folds to idle for routing, like failed", () => {
  expect(deriveThreadState(task("failed_resumable"), "th")).toBe("idle");
});

test("gate recognized by the running stage when no approval row is pending", () => {
  const plan = task("waiting_approval");
  upsertStage(plan, { turnId: "t1", idx: 0, name: "plan", status: "running" });
  expect(deriveThreadState(plan, "th")).toBe("awaiting_plan_approval");
  const exec = task("waiting_approval");
  upsertStage(exec, { turnId: "t1", idx: 1, name: "exec", status: "running" });
  expect(deriveThreadState(exec, "th")).toBe("running"); // the exec stage has no gate since Rev 15
  expect(deriveThreadState(task("waiting_approval"), "th")).toBe("running"); // no hint at all
});

test("done folds to idle", () => {
  const db = task("running");
  finishTurn(db, "t1", "done");
  expect(deriveThreadState(db, "th")).toBe("done");
  expect(isIdleLike("done")).toBe(true);
  expect(isIdleLike("idle")).toBe(true);
  expect(isIdleLike("running")).toBe(false);
  expect(isIdleLike("awaiting_plan_approval")).toBe(false);
  expect(isIdleLike("awaiting_result")).toBe(false);
});

test("the newest task decides; other threads are ignored", () => {
  const db = task("done");
  insertTurn(db, { id: "t2", threadId: "th", source: "t", repo: "r", role: "dev" });
  expect(deriveThreadState(db, "th")).toBe("running");
  expect(deriveThreadState(db, "other")).toBe("idle");
});

test("a task row of an unknown role is idle-like, not a crash", () => {
  const db = task("waiting_approval");
  db.query("UPDATE turns SET role = 'ghost-role' WHERE id = 't1'").run();
  upsertStage(db, { turnId: "t1", idx: 0, name: "x", status: "running" });
  expect(deriveThreadState(db, "th")).toBe("idle");
});

test("restart while awaiting a tool approval (owner decision 6): interrupted + Resume offer, approval cancelled, thread idle", () => {
  const db = task("waiting_approval");
  pending(db, "Bash");
  expect(deriveThreadState(db, "th")).toBe("awaiting_tool_approval");
  interruptRunningTurns(db); // what startup / shutdown does to a crashed or drained run
  expect(db.query("SELECT status FROM turns WHERE id = 't1'").get()).toEqual({
    status: "interrupted",
  });
  expect(db.query("SELECT decision FROM approvals WHERE id = 'ap1'").get()).toEqual({
    decision: "cancelled",
  });
  expect(listInterruptedThreads(db)).toEqual(["th"]); // the thread gets its Resume notice
  expect(deriveThreadState(db, "th")).toBe("idle");
  expect(pendingToolApproval(db, "t1")).toBeUndefined();
});
