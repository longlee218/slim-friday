import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { AUTO_RESUME_CAP } from "../src/config/resilience-caps";
import type { RunOutcome } from "../src/observability/run-usage";
import type { FlowResult } from "../src/orchestrator/turns/turn-result";
import { applyFailurePolicy } from "../src/orchestrator/worker/failure-policy";
import { clearHold, holdUntil, waitMs } from "../src/orchestrator/worker/resume-backoff";
import { openDb } from "../src/storage/db";
import { getItem } from "../src/storage/owned-item-store";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { insertTurn, setTurnSession, turnSessionId } from "../src/storage/run-store";
import { canTransition } from "../src/tasks/task-state-machine";

/* The failure policy over a real db: transient -> ready (capped, backoff), real -> held blocked, owner stop untouched. */

let db: Database;
afterEach(() => db?.close());

/** A goal with one running item `it` (and a turn `tn`); `standalone` = a task without a goal. */
function setup(attempt = 0, standalone = false) {
  db = openDb(":memory:");
  if (!standalone)
    insertOwnedTask(db, {
      id: "g",
      threadId: "th",
      ownerRole: "chief-of-staff",
      status: "open",
      scope: "g",
      correlationId: "c",
    });
  insertOwnedTask(db, {
    id: "it",
    threadId: "th",
    ownerRole: "developer",
    status: "running",
    scope: "s",
    correlationId: "c",
    ...(!standalone && { parentId: "g", itemKey: "main" }),
  });
  db.query("UPDATE owned_tasks SET attempt = ? WHERE id = 'it'").run(attempt);
  insertTurn(db, { id: "tn", threadId: "th", source: "t", location: "r", role: "developer" });
}
const res = (outcome: RunOutcome, text = "", transient?: true): FlowResult => ({
  text,
  outcome,
  sessionId: "s1",
  ...(transient && { transient }),
});
const run = (r: FlowResult, o: Partial<Parameters<typeof applyFailurePolicy>[0]> = {}) =>
  applyFailurePolicy({
    db,
    itemId: "it",
    turnId: "tn",
    res: r,
    status: "failed",
    stopping: false,
    ...o,
  });

test("state machine: running -> ready (auto resume) and blocked -> failed (teammate gives up) are allowed", () => {
  expect(canTransition("running", "ready")).toBe(true);
  expect(canTransition("blocked", "failed")).toBe(true);
  expect(canTransition("blocked", "ready")).toBe(true);
  expect(canTransition("failed", "ready")).toBe(false); // terminal stays terminal
});

test("overload: resumed twice at +2 s and +4 s (same item, attempt counted), the third failure holds it", () => {
  setup();
  const t0 = 1_000_000;
  const overload = res("quota", "", true);
  expect(run(overload, { now: t0 })).toMatchObject({
    action: "resume",
    cause: "api_error",
    attempt: 1,
  });
  expect(getItem(db, "it")).toMatchObject({ status: "ready", attempt: 1 });
  expect(waitMs("it", t0 + 1999)).toBe(1);
  expect(waitMs("it", t0 + 2000)).toBe(0); // due: the entry is dropped
  db.query("UPDATE owned_tasks SET status = 'running' WHERE id = 'it'").run(); // the resumed run started
  expect(run(overload, { now: t0 })).toMatchObject({ action: "resume", attempt: 2 });
  expect(waitMs("it", t0 + 3000)).toBe(1000); // 2nd resume waits 4 s in total
  expect(waitMs("it", t0 + 4000)).toBe(0);
  db.query("UPDATE owned_tasks SET status = 'running' WHERE id = 'it'").run();
  const v = run(overload);
  expect(v).toMatchObject({
    action: "hold",
    class: "real",
    cause: "resume_cap:api_error",
    attempt: AUTO_RESUME_CAP,
  });
  expect(getItem(db, "it")).toMatchObject({ status: "blocked", resultKind: "FAILED" });
});

test("a real error holds the item blocked with result FAILED (no resume)", () => {
  setup();
  expect(run(res("error", ""))).toMatchObject({ action: "hold", class: "real", cause: "error" });
  expect(getItem(db, "it")).toMatchObject({ status: "blocked", resultKind: "FAILED", attempt: 0 });
});

test("max_budget is a real failure (held)", () => {
  setup();
  expect(run(res("max_budget"))).toMatchObject({ action: "hold", cause: "max_budget" });
});

test("a worker that reports FAILED is held, never resumed", () => {
  setup();
  const v = run(res("success"), { status: "done", resultKind: "FAILED" });
  expect(v).toMatchObject({ action: "hold", cause: "worker_failed" });
  expect(getItem(db, "it")).toMatchObject({ status: "blocked", resultKind: "FAILED" });
});

test("other typed results and no-report successes are left to the normal settle", () => {
  setup();
  expect(run(res("success"), { status: "done", resultKind: "COMPLETED" })).toBeUndefined();
  expect(run(res("success"), { status: "done" })).toBeUndefined();
  expect(getItem(db, "it")?.status).toBe("running");
});

test("a stale abort (watchdog) is consumed as a transient failure", () => {
  setup();
  expect(run(res("aborted"), { abortCause: "stale", status: "cancelled" })).toMatchObject({
    action: "resume",
    cause: "stale",
  });
  expect(getItem(db, "it")?.status).toBe("ready");
});

test("shutdown (SIGTERM) abort resumes; an owner stop is untouched", () => {
  setup();
  expect(run(res("aborted"), { stopping: true, status: "interrupted" })).toMatchObject({
    cause: "shutdown",
  });
  expect(getItem(db, "it")?.status).toBe("ready");
  db.query("UPDATE owned_tasks SET status = 'running' WHERE id = 'it'").run();
  expect(run(res("aborted"), { status: "cancelled" })).toBeUndefined();
  expect(getItem(db, "it")?.status).toBe("running");
});

test("a failed resume clears the turn's session so the next start falls back to the brief", () => {
  setup();
  setTurnSession(db, "tn", "s1");
  run(res("error", "No conversation found with session ID s1"));
  expect(turnSessionId(db, "tn") || undefined).toBeUndefined();
  expect(getItem(db, "it")?.status).toBe("ready");
});

test("a standalone task (no goal) and an item no longer running are not touched", () => {
  setup(0, true);
  expect(run(res("error"))).toBeUndefined();
  db.close();
  setup();
  db.query("UPDATE owned_tasks SET status = 'cancelled' WHERE id = 'it'").run(); // the teammate cancelled it
  expect(run(res("aborted"), { stopping: true })).toBeUndefined();
});

test("the backoff entry is dropped once the item left ready (cancelled / ended items keep none)", () => {
  holdUntil("gone", 5_000);
  expect(waitMs("gone", 1_000)).toBe(4_000);
  clearHold("gone");
  expect(waitMs("gone", 1_000)).toBe(0);
});
