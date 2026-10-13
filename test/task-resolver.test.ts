import { expect, test } from "bun:test";
import { captureLogs, logger } from "../src/observability/logger";
import { NO_DELIVERY_NOTE } from "../src/orchestrator/outputs/outcome-validator";
import { closeTurn, type FlowResult } from "../src/orchestrator/turns/turn-result";
import { beginTurn, failTurn } from "../src/orchestrator/turns/turn-tracker";
import { ROLES } from "../src/roles/role-registry";
import type { TaskState } from "../src/routing/routing-contracts";
import { openDb } from "../src/storage/db";
import { casUpdateTask, getOwnedTask, ownedTaskOfTurn } from "../src/storage/owned-task-store";
import { finishTurn, insertTurn, interruptRunningTurns } from "../src/storage/run-store";
import {
  attachTurnToTask,
  changeOwner,
  openTask,
  resolveTaskContext,
  settleTaskAfterTurn,
} from "../src/tasks/task-resolver";
import { canTransition } from "../src/tasks/task-state-machine";
import { makeEnv } from "./helpers";

const background = Object.values(ROLES).find((r) => r.background)!.name;
const foreground = Object.values(ROLES).find((r) => !r.background)!.name;

const begin = (
  db: ReturnType<typeof makeEnv>["db"],
  id: string,
  role: string,
  extra: { resume?: boolean; parentTurnId?: string; ownedTaskId?: string; threadId?: string } = {},
) =>
  beginTurn(
    db,
    logger,
    { turnId: id, threadId: extra.threadId ?? "th", source: "test" },
    { repo: "*", role, brief: `brief of ${id}`, ...extra },
  );

test("a background turn opens a running task owned by its role", () => {
  const { db } = makeEnv();
  begin(db, "t1", background);
  const taskId = ownedTaskOfTurn(db, "t1")!;
  expect(getOwnedTask(db, taskId)).toMatchObject({
    ownerAgentId: background,
    status: "running",
    scope: "brief of t1",
  });
  expect(resolveTaskContext(db, "th").active?.taskId).toBe(taskId);
});

test("a foreground turn (idle or side lane) creates no task and leaves the focus alone", () => {
  const { db } = makeEnv();
  begin(db, "t1", background);
  const focus = resolveTaskContext(db, "th").active?.taskId;
  begin(db, "a1", foreground);
  begin(db, "a2", foreground, { threadId: "th:side" });
  expect(ownedTaskOfTurn(db, "a1")).toBeUndefined();
  expect(ownedTaskOfTurn(db, "a2")).toBeUndefined();
  expect(db.query("SELECT COUNT(*) AS n FROM owned_tasks").get()).toEqual({ n: 1 });
  expect(resolveTaskContext(db, "th").active?.taskId).toBe(focus);
  expect(resolveTaskContext(db, "th:side")).toEqual({});
});

test("every owner_role is a background role", () => {
  const { db } = makeEnv();
  begin(db, "t1", background);
  begin(db, "a1", foreground);
  const owners = db.query<{ r: string }, []>("SELECT owner_role AS r FROM owned_tasks").all();
  for (const o of owners) expect(ROLES[o.r]!.background).toBe(true);
});

test("topic switch opens a second task; the first stays unchanged; newest is the focus", async () => {
  const { db } = makeEnv();
  begin(db, "t1", background);
  const first = ownedTaskOfTurn(db, "t1")!;
  finishTurn(db, "t1", "done");
  settleTaskAfterTurn(db, "t1", "done");
  await Bun.sleep(3);
  begin(db, "t2", background);
  const second = ownedTaskOfTurn(db, "t2")!;
  expect(second).not.toBe(first);
  expect(getOwnedTask(db, first)).toMatchObject({ status: "completed", version: 1 });
  expect(resolveTaskContext(db, "th").active?.taskId).toBe(second);
});

test("resume reuses the parent's task; a named ownedTaskId links to it", () => {
  const { db } = makeEnv();
  begin(db, "t1", background);
  const taskId = ownedTaskOfTurn(db, "t1")!;
  finishTurn(db, "t1", "failed_resumable");
  settleTaskAfterTurn(db, "t1", "failed_resumable");
  expect(getOwnedTask(db, taskId)?.status).toBe("waiting_user");
  begin(db, "t2", background, { resume: true, parentTurnId: "t1" });
  expect(ownedTaskOfTurn(db, "t2")).toBe(taskId);
  expect(getOwnedTask(db, taskId)?.status).toBe("running");
  begin(db, "t3", background, { ownedTaskId: taskId });
  expect(ownedTaskOfTurn(db, "t3")).toBe(taskId);
  expect(db.query("SELECT COUNT(*) AS n FROM owned_tasks").get()).toEqual({ n: 1 });
});

test("a finished task is not reopened by a resume: a new task opens", () => {
  const { db } = makeEnv();
  begin(db, "t1", background);
  const taskId = ownedTaskOfTurn(db, "t1")!;
  settleTaskAfterTurn(db, "t1", "done");
  begin(db, "t2", background, { resume: true, parentTurnId: "t1" });
  expect(ownedTaskOfTurn(db, "t2")).not.toBe(taskId);
  expect(getOwnedTask(db, taskId)?.status).toBe("completed");
});

test("turn end settles the task: done / waiting / failed / cancelled; unlinked turn is a no-op", () => {
  const { db } = makeEnv();
  const cases: [string, TaskState["status"]][] = [
    ["done", "completed"],
    ["failed_resumable", "waiting_user"],
    ["interrupted", "waiting_user"],
    ["failed", "failed"],
    ["timeout", "failed"],
    ["cancelled", "cancelled"],
  ];
  cases.forEach(([turnStatus, taskStatus], i) => {
    begin(db, `t${i}`, background);
    settleTaskAfterTurn(db, `t${i}`, turnStatus);
    expect(getOwnedTask(db, ownedTaskOfTurn(db, `t${i}`)!)?.status).toBe(taskStatus);
  });
  begin(db, "a", foreground);
  expect(() => settleTaskAfterTurn(db, "a", "done")).not.toThrow();
});

test("closeTurn settles through the real path (delivered success -> completed; shutdown abort -> waiting_user)", () => {
  const { db } = makeEnv();
  const res = (outcome: FlowResult["outcome"], text = "x"): FlowResult => ({
    text,
    outcome,
    sessionId: undefined,
  });
  const o = { stopping: false, t0: Date.now(), repo: "*" };
  begin(db, "t1", background);
  closeTurn(
    db,
    { turnId: "t1", threadId: "th" },
    res("success", "opened https://github.com/o/r/pull/7"),
    o,
  );
  expect(getOwnedTask(db, ownedTaskOfTurn(db, "t1")!)?.status).toBe("completed");
  begin(db, "t2", background);
  closeTurn(db, { turnId: "t2", threadId: "th" }, res("aborted"), { ...o, stopping: true });
  expect(getOwnedTask(db, ownedTaskOfTurn(db, "t2")!)?.status).toBe("waiting_user");
});

test("restart reconcile: a running task whose turn became interrupted waits for the owner", () => {
  const { db } = makeEnv();
  begin(db, "t1", background);
  const taskId = ownedTaskOfTurn(db, "t1")!;
  interruptRunningTurns(db);
  expect(getOwnedTask(db, taskId)?.status).toBe("waiting_user");
});

test("changeOwner: CAS, logs from/to/reason/trace; a stale snapshot is retried; a lost race returns false", () => {
  const { db } = makeEnv();
  const cap = captureLogs();
  const task = openTask(db, { threadId: "th", owner: "a", scope: "s", traceId: "tr" });
  // The snapshot goes stale (someone bumped the version): the retry re-reads and wins.
  casUpdateTask(db, task.taskId, 0, { status: "running" });
  expect(changeOwner(db, task, background, "EXPLICIT_SWITCH", "tr2")).toBe(true);
  cap.stop();
  expect(getOwnedTask(db, task.taskId)).toMatchObject({ ownerAgentId: background, version: 2 });
  const line = cap.lines.find((l) => l.event === "task.owner_changed");
  expect(line).toMatchObject({
    ownedTaskId: task.taskId,
    from: "a",
    to: background,
    reasonCode: "EXPLICIT_SWITCH",
    traceId: "tr2",
  });
  // A task that vanished cannot be changed.
  expect(changeOwner(db, { ...task, taskId: "gone" }, background, "EXPLICIT_SWITCH", "tr3")).toBe(
    false,
  );
});

test("state machine: terminal states have no exit; waiting_user continues", () => {
  expect(canTransition("waiting_user", "running")).toBe(true);
  expect(canTransition("completed", "running")).toBe(false);
  expect(canTransition("cancelled", "failed")).toBe(false);
  expect(canTransition("running", "running")).toBe(true);
});

test("attachTurnToTask scope is redacted and clipped to one line", () => {
  const { db } = makeEnv();
  insertTurn(db, { id: "t1", threadId: "th", source: "x", repo: "*", role: background });
  const id = attachTurnToTask(db, {
    turnId: "t1",
    threadId: "th",
    owner: background,
    scope: `line one\nline two ${"x".repeat(400)}`,
    traceId: "tr",
  });
  const scope = getOwnedTask(db, id)!.scope;
  expect(scope.length).toBeLessThanOrEqual(160);
  expect(scope).not.toContain("\n");
});

test("failTurn (crash path) settles a background turn's task to failed; a foreground turn is a no-op", () => {
  const { db } = makeEnv();
  begin(db, "t1", background);
  const taskId = ownedTaskOfTurn(db, "t1")!;
  failTurn(db, logger, "t1");
  expect(getOwnedTask(db, taskId)?.status).toBe("failed");
  begin(db, "a1", foreground);
  expect(() => failTurn(db, logger, "a1")).not.toThrow();
  expect(ownedTaskOfTurn(db, "a1")).toBeUndefined();
});

test("restart: a running task survives a db close; startup reconcile leaves it waiting for its owner", () => {
  const { db, paths } = makeEnv();
  begin(db, "t1", background);
  const taskId = ownedTaskOfTurn(db, "t1")!;
  db.close();
  const again = openDb(paths.dbFile);
  expect(getOwnedTask(again, taskId)).toMatchObject({
    status: "running",
    ownerAgentId: background,
  });
  // Same call index.ts makes at startup, on the reopened db.
  interruptRunningTurns(again);
  expect(getOwnedTask(again, taskId)).toMatchObject({
    status: "waiting_user",
    ownerAgentId: background,
  });
});

test("a task of another thread is refused: a new task opens in this thread, nothing else changes", () => {
  const { db } = makeEnv();
  begin(db, "t1", background, { threadId: "other" });
  const foreign = ownedTaskOfTurn(db, "t1")!;
  begin(db, "t2", background, { ownedTaskId: foreign });
  const mine = ownedTaskOfTurn(db, "t2")!;
  expect(mine).not.toBe(foreign);
  expect(getOwnedTask(db, foreign)).toMatchObject({ status: "running", version: 0 });
});

test("a turn of another background role takes the task over and logs task.owner_changed", () => {
  const { db } = makeEnv();
  const other = Object.values(ROLES).find((r) => r.background && r.name !== background);
  if (!other) return; // only one background role registered
  begin(db, "t1", background);
  const taskId = ownedTaskOfTurn(db, "t1")!;
  const cap = captureLogs();
  begin(db, "t2", other.name, { ownedTaskId: taskId });
  cap.stop();
  expect(getOwnedTask(db, taskId)?.ownerAgentId).toBe(other.name);
  expect(cap.lines.some((l) => l.event === "task.owner_changed" && l.to === other.name)).toBe(true);
});

test("changeOwner refuses a non-background target", () => {
  const { db } = makeEnv();
  const task = openTask(db, { threadId: "th", owner: background, scope: "s", traceId: "tr" });
  expect(changeOwner(db, task, foreground, "EXPLICIT_SWITCH", "tr")).toBe(false);
  expect(getOwnedTask(db, task.taskId)?.ownerAgentId).toBe(background);
});

test("beginTurn is atomic: a failing task link leaves no turn row", () => {
  const { db } = makeEnv();
  db.exec("DROP TABLE owned_tasks");
  expect(() => begin(db, "t1", background)).toThrow();
  expect(db.query("SELECT COUNT(*) AS n FROM turns").get()).toEqual({ n: 0 });
});

test("closeTurn: a failed or aborted run gets no no-delivery note and its task is not parked as undelivered", () => {
  const { db } = makeEnv();
  const o = { stopping: false, t0: Date.now(), repo: "*" };
  begin(db, "f1", background);
  const failed = closeTurn(
    db,
    { turnId: "f1", threadId: "th" },
    { text: "boom", outcome: "error", sessionId: undefined },
    o,
  );
  expect(failed).not.toContain(NO_DELIVERY_NOTE);
  expect(getOwnedTask(db, ownedTaskOfTurn(db, "f1")!)?.status).toBe("failed");
  begin(db, "a1", background);
  const aborted = closeTurn(
    db,
    { turnId: "a1", threadId: "th" },
    { text: "", outcome: "aborted", sessionId: undefined },
    o,
  );
  expect(aborted).not.toContain(NO_DELIVERY_NOTE);
  expect(getOwnedTask(db, ownedTaskOfTurn(db, "a1")!)?.status).toBe("cancelled");
});
