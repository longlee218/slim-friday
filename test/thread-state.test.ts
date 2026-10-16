import { expect, test } from "bun:test";
import { OWNER_CONFIRM_APPROVAL } from "../src/orchestrator/engine/owner-confirm";
import {
  deriveThreadState,
  isIdleLike,
  pendingToolApproval,
} from "../src/orchestrator/thread/thread-state";
import { insertApproval } from "../src/storage/approval-store";
import {
  finishTurn,
  insertTurn,
  interruptRunningTurns,
  setTurnStatus,
} from "../src/storage/run-store";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { makeEnv } from "./helpers";

/** One thread, one code task in `status`. */
function task(status: Parameters<typeof setTurnStatus>[2], role = "developer") {
  const { db } = makeEnv();
  insertTurn(db, { id: "t1", threadId: "th", source: "t", location: "r", role });
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
  expect(deriveThreadState(task("running", "lead"), "th")).toBe("running");
});

test("awaiting_owner: the run waits on an AskUserQuestion (the plan approval is one); not a gate", () => {
  const db = task("waiting_approval");
  pending(db, ASK_USER_QUESTION_TOOL_NAME);
  expect(deriveThreadState(db, "th")).toBe("awaiting_owner");
  expect(pendingToolApproval(db, "t1")?.tool).toBe(ASK_USER_QUESTION_TOOL_NAME);
});

test("an owner-confirm yes/no is a plain pending approval: awaiting_owner", () => {
  const db = task("waiting_approval");
  pending(db, OWNER_CONFIRM_APPROVAL);
  expect(deriveThreadState(db, "th")).toBe("awaiting_owner");
  expect(isIdleLike("awaiting_owner")).toBe(false);
});

test("no delivery gate any more: a pending approval labelled CreatePR (old row) is a plain tool approval", () => {
  const db = task("waiting_approval");
  pending(db, "CreatePR");
  expect(deriveThreadState(db, "th")).toBe("awaiting_owner");
});

test("awaiting_owner: a pending tool approval is not a gate; the decision lands -> running again", () => {
  const db = task("waiting_approval");
  pending(db, "Bash");
  expect(deriveThreadState(db, "th")).toBe("awaiting_owner");
  expect(isIdleLike("awaiting_owner")).toBe(false);
  expect(pendingToolApproval(db, "t1")?.tool).toBe("Bash");
  db.query("UPDATE approvals SET decision = 'approved'").run();
  db.query("UPDATE turns SET status = 'running'").run();
  expect(deriveThreadState(db, "th")).toBe("running");
  expect(pendingToolApproval(db, "t1")).toBeUndefined();
});

test("failed_resumable folds to idle for routing, like failed", () => {
  expect(deriveThreadState(task("failed_resumable"), "th")).toBe("idle");
});

test("waiting with no pending approval row (the decision just landed) is running; no role or stage is consulted", () => {
  expect(deriveThreadState(task("waiting_approval"), "th")).toBe("running");
  const ghost = task("waiting_approval");
  ghost.query("UPDATE turns SET role = 'ghost-role' WHERE id = 't1'").run();
  expect(deriveThreadState(ghost, "th")).toBe("running");
});

test("done folds to idle", () => {
  const db = task("running");
  finishTurn(db, "t1", "done");
  expect(deriveThreadState(db, "th")).toBe("done");
  expect(isIdleLike("done")).toBe(true);
  expect(isIdleLike("idle")).toBe(true);
  expect(isIdleLike("running")).toBe(false);
  expect(isIdleLike("awaiting_owner")).toBe(false);
});

test("the newest task decides; other threads are ignored", () => {
  const db = task("done");
  insertTurn(db, { id: "t2", threadId: "th", source: "t", location: "r", role: "developer" });
  expect(deriveThreadState(db, "th")).toBe("running");
  expect(deriveThreadState(db, "other")).toBe("idle");
});

test("restart while awaiting a tool approval (owner decision 6): interrupted + Resume offer, approval cancelled, thread idle", () => {
  const db = task("waiting_approval");
  pending(db, "Bash");
  expect(deriveThreadState(db, "th")).toBe("awaiting_owner");
  interruptRunningTurns(db); // what startup / shutdown does to a crashed or drained run
  expect(db.query("SELECT status FROM turns WHERE id = 't1'").get()).toEqual({
    status: "interrupted",
  });
  expect(db.query("SELECT decision FROM approvals WHERE id = 'ap1'").get()).toEqual({
    decision: "cancelled",
  });
  expect(deriveThreadState(db, "th")).toBe("idle");
  expect(pendingToolApproval(db, "t1")).toBeUndefined();
});
