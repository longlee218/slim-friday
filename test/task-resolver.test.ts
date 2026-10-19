import { expect, test } from "bun:test";
import { renderUserNotice } from "../src/ingress/user-copy";
import { GIT_PUSH_TOOL } from "../src/mcp/effects/tools/GitPushTool/constants";
import { captureLogs, logger } from "../src/observability/logger";
import { closeTurn, type FlowResult } from "../src/orchestrator/turns/turn-result";
import { beginTurn, failTurn } from "../src/orchestrator/turns/turn-tracker";
import { ROLES } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { appendEffect } from "../src/storage/effect-log-store";
import {
  activeOwnedTask,
  casUpdateTask,
  getOwnedTask,
  ownedTaskOfTurn,
} from "../src/storage/owned-task-store";
import { finishTurn, insertTurn, interruptRunningTurns } from "../src/storage/run-store";
import type { TaskState } from "../src/tasks/task-contracts";
import {
  attachTurnToTask,
  changeOwner,
  openTask,
  settleTaskAfterTurn,
} from "../src/tasks/task-resolver";
import { canTransition } from "../src/tasks/task-state-machine";
import { makeEnv } from "./helpers";

const NO_DELIVERY_NOTE = renderUserNotice({ kind: "note", state: "no-delivery" }, "en");

const background = Object.values(ROLES).find((r) => r.kind === "worker")!.name;
const foreground = Object.values(ROLES).find((r) => r.kind !== "worker")!.name;

const begin = (
  db: ReturnType<typeof makeEnv>["db"],
  id: string,
  role: string,
  extra: { ownedTaskId?: string; threadId?: string } = {},
) =>
  beginTurn(
    db,
    logger,
    { turnId: id, threadId: extra.threadId ?? "th", source: "test" },
    { location: "*", role, brief: `brief of ${id}`, ...extra },
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
  expect(activeOwnedTask(db, "th")?.taskId).toBe(taskId);
});

test("a foreground turn (idle or side lane) creates no task and leaves the focus alone", () => {
  const { db } = makeEnv();
  begin(db, "t1", background);
  const focus = activeOwnedTask(db, "th")?.taskId;
  begin(db, "a1", foreground);
  begin(db, "a2", foreground, { threadId: "th:side" });
  expect(ownedTaskOfTurn(db, "a1")).toBeUndefined();
  expect(ownedTaskOfTurn(db, "a2")).toBeUndefined();
  expect(db.query("SELECT COUNT(*) AS n FROM owned_tasks").get()).toEqual({ n: 1 });
  expect(activeOwnedTask(db, "th")?.taskId).toBe(focus);
  expect(activeOwnedTask(db, "th:side")).toBeUndefined();
});

test("every owner_role is a background role", () => {
  const { db } = makeEnv();
  begin(db, "t1", background);
  begin(db, "a1", foreground);
  const owners = db.query<{ r: string }, []>("SELECT owner_role AS r FROM owned_tasks").all();
  for (const o of owners) expect(ROLES[o.r]!.kind).toBe("worker");
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
  expect(activeOwnedTask(db, "th")?.taskId).toBe(second);
});

test("a named ownedTaskId links the turn to that task and moves a held one back to running", () => {
  const { db } = makeEnv();
  begin(db, "t1", background);
  const taskId = ownedTaskOfTurn(db, "t1")!;
  finishTurn(db, "t1", "interrupted");
  settleTaskAfterTurn(db, "t1", "interrupted");
  expect(getOwnedTask(db, taskId)?.status).toBe("waiting_user");
  begin(db, "t2", background, { ownedTaskId: taskId });
  expect(ownedTaskOfTurn(db, "t2")).toBe(taskId);
  expect(getOwnedTask(db, taskId)?.status).toBe("running");
  expect(db.query("SELECT COUNT(*) AS n FROM owned_tasks").get()).toEqual({ n: 1 });
});

test("a finished task is not reopened by a named ownedTaskId: a new task opens", () => {
  const { db } = makeEnv();
  begin(db, "t1", background);
  const taskId = ownedTaskOfTurn(db, "t1")!;
  settleTaskAfterTurn(db, "t1", "done");
  begin(db, "t2", background, { ownedTaskId: taskId });
  expect(ownedTaskOfTurn(db, "t2")).not.toBe(taskId);
  expect(getOwnedTask(db, taskId)?.status).toBe("completed");
});

test("turn end settles the task: done / waiting / failed / cancelled; unlinked turn is a no-op", () => {
  const { db } = makeEnv();
  const cases: [string, TaskState["status"]][] = [
    ["done", "completed"],
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

test("closeTurn settles through the real path (reported COMPLETED -> completed; shutdown abort -> waiting_user)", () => {
  const { db } = makeEnv();
  const res = (outcome: FlowResult["outcome"], text = "x"): FlowResult => ({
    text,
    outcome,
    sessionId: undefined,
  });
  const o = { language: "en" as const, stopping: false, t0: Date.now(), location: "*" };
  begin(db, "t1", background);
  closeTurn(db, { turnId: "t1", threadId: "th" }, res("success", "opened a PR"), {
    ...o,
    resultKind: "COMPLETED",
  });
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
  insertTurn(db, { id: "t1", threadId: "th", source: "x", location: "*", role: background });
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
  const other = Object.values(ROLES).find((r) => r.kind === "worker" && r.name !== background);
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
  db.run("DROP TABLE owned_tasks");
  expect(() => begin(db, "t1", background)).toThrow();
  expect(db.query("SELECT COUNT(*) AS n FROM turns").get()).toEqual({ n: 0 });
});

test("closeTurn: a failed or aborted run gets no no-delivery note and its task is not parked as undelivered", () => {
  const { db } = makeEnv();
  const o = { language: "en" as const, stopping: false, t0: Date.now(), location: "*" };
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

/** Close a worker turn that ended `done` with `resultKind`, and the goal's delivery expectation `want`. */
const closeWorker = (
  db: ReturnType<typeof makeEnv>["db"],
  id: string,
  over: Partial<Parameters<typeof closeTurn>[3]>,
  role = background,
): string => {
  begin(db, id, role);
  return closeTurn(
    db,
    { turnId: id, threadId: "th" },
    { text: "done", outcome: "success", sessionId: undefined },
    { language: "en", stopping: false, t0: Date.now(), location: "*", ...over },
  );
};
const statusOf = (db: ReturnType<typeof makeEnv>["db"], id: string) =>
  getOwnedTask(db, ownedTaskOfTurn(db, id)!)?.status;
const want = { goalId: "g1", tools: [GIT_PUSH_TOOL] };
const effectRow = (db: ReturnType<typeof makeEnv>["db"], id: string, result: object) =>
  appendEffect(db, {
    id,
    threadId: "th",
    goalId: "g1",
    tool: GIT_PUSH_TOOL,
    scope: "api",
    grantedBy: "plan",
    result: JSON.stringify(result),
  });

test("completion: COMPLETED without the required effect row = reported, not delivered (note, task still completed)", () => {
  const { db } = makeEnv();
  const reply = closeWorker(db, "c1", { resultKind: "COMPLETED", delivery: want });
  expect(reply).toContain(NO_DELIVERY_NOTE);
  expect(statusOf(db, "c1")).toBe("completed");
});

test("completion: COMPLETED with a successful effect_log row is delivered (no note)", () => {
  const { db } = makeEnv();
  effectRow(db, "e1", { code: 0, out: "pushed" });
  const reply = closeWorker(db, "c2", { resultKind: "COMPLETED", delivery: want });
  expect(reply).not.toContain(NO_DELIVERY_NOTE);
  expect(statusOf(db, "c2")).toBe("completed");
});

test("completion: a refused or failed effect row is no delivery", () => {
  const { db } = makeEnv();
  effectRow(db, "e1", { result: "refused", code: "OUTSIDE_ENVELOPE" });
  effectRow(db, "e2", { code: 1, out: "rejected" });
  const reply = closeWorker(db, "c3", { resultKind: "COMPLETED", delivery: want });
  expect(reply).toContain(NO_DELIVERY_NOTE);
});

test("completion: FAILED / BLOCKED / NEEDS_CLARIFICATION settle as reported, with no delivery note", () => {
  const { db } = makeEnv();
  const expected = {
    FAILED: "failed",
    BLOCKED: "blocked",
    NEEDS_CLARIFICATION: "waiting_user",
  } as const;
  for (const [kind, status] of Object.entries(expected)) {
    const reply = closeWorker(db, `k-${kind}`, {
      resultKind: kind as keyof typeof expected,
      delivery: want,
    });
    expect(reply).not.toContain(NO_DELIVERY_NOTE);
    expect(statusOf(db, `k-${kind}`)).toBe(status);
  }
});

test("completion: a done run with no Report result is not completed when the role changes things; a read-only role completes", () => {
  const { db } = makeEnv();
  const changer = Object.values(ROLES).find(
    (r) => r.kind === "worker" && r.sideEffects !== "none",
  )!;
  const reader = Object.values(ROLES).find((r) => r.kind === "worker" && r.sideEffects === "none")!;
  const reply = closeWorker(db, "n1", { delivery: want }, changer.name);
  expect(reply).not.toContain(NO_DELIVERY_NOTE);
  expect(statusOf(db, "n1")).toBe("waiting_user");
  closeWorker(db, "n2", {}, reader.name);
  expect(statusOf(db, "n2")).toBe("completed");
});
