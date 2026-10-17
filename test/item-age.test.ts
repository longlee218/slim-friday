import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ITEM_MAX_AGE_MS, STALE_AFTER_MS } from "../src/config/resilience-caps";
import { createRetryPort } from "../src/orchestrator/goal/effect-port-retry";
import type { LeadRuntime } from "../src/orchestrator/lead/lead-runtime";
import { registerRun, runOfTask } from "../src/orchestrator/run/live-runs";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import {
  applyFailurePolicy,
  type FailureVerdict,
  workerFailurePolicy,
} from "../src/orchestrator/worker/failure-policy";
import { sweepItemAge } from "../src/orchestrator/worker/item-age";
import { createQuestionRelay } from "../src/orchestrator/worker/question-relay";
import { waitMs } from "../src/orchestrator/worker/resume-backoff";
import { emitEndEvent } from "../src/orchestrator/worker/worker-end-event";
import { startWorker } from "../src/orchestrator/worker/worker-run";
import { classifyRunFailure } from "../src/runtime/failure-class";
import { openDb } from "../src/storage/db";
import { agedItems } from "../src/storage/item-age-store";
import { getItem } from "../src/storage/owned-item-store";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { insertTurn } from "../src/storage/run-store";
import { listUndelivered } from "../src/storage/thread-event-store";
import { moveTaskTo } from "../src/tasks/task-resolver";

/* Item age limit over a real db and a fake clock (`now` is passed in; no real 8 h waits). */

const H = 3_600_000;
const T0 = 1_000_000_000_000;
let db: Database;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
  db?.close();
});

const rtOf = (): { rt: LeadRuntime; woken: string[] } => {
  const woken: string[] = [];
  return {
    rt: { deps: { db }, announce: (t: string) => void woken.push(t) } as unknown as LeadRuntime,
    woken,
  };
};

/** A goal `g` with one item `it` in `status`, its last_progress_at at T0; `turnAt` = start times of its turns. */
function setup(status: string, turnAt: number[] = [], database?: Database) {
  db = database ?? openDb(":memory:");
  insertOwnedTask(db, {
    id: "g",
    threadId: "th",
    ownerRole: "lead",
    status: "open",
    scope: "g",
    correlationId: "c",
  });
  insertOwnedTask(db, {
    id: "it",
    threadId: "th",
    ownerRole: "developer",
    status: status as never,
    scope: "s",
    correlationId: "c",
    parentId: "g",
    itemKey: "main",
  });
  db.query("UPDATE owned_tasks SET last_progress_at = ? WHERE id = 'it'").run(T0);
  for (const [n, at] of turnAt.entries()) addTurn(`tn${n}`, at);
}
function addTurn(id: string, at: number) {
  insertTurn(db, { id, threadId: "th", source: "t", location: "r", role: "developer" });
  db.query("UPDATE turns SET started_at = ?, owned_task_id = 'it' WHERE id = ?").run(at, id);
}
const aged = (now: number) => agedItems(db, now, ITEM_MAX_AGE_MS).map((a) => a.id);

test("never-started ready item: clock = last_progress_at; held directly past 8 h with a failure event and a wake", () => {
  setup("ready");
  const { rt, woken } = rtOf();
  expect(sweepItemAge(rt, T0 + ITEM_MAX_AGE_MS)).toBe(0); // exactly 8 h: not over
  expect(sweepItemAge(rt, T0 + ITEM_MAX_AGE_MS + 1)).toBe(1);
  const it = getItem(db, "it")!;
  expect([it.status, it.resultKind]).toEqual(["blocked", "FAILED"]);
  const ev = listUndelivered(db, "th").filter((e) => e.kind === "failure");
  expect(ev).toHaveLength(1);
  expect(ev[0]!.payload).toMatchObject({ key: "main", class: "real", cause: "item_age" });
  expect(woken).toEqual(["th"]);
  expect(sweepItemAge(rt, T0 + 9 * H)).toBe(0); // blocked: not swept again, no second event
});

test("waiting_user item (owner never answered) past 8 h is held", () => {
  setup("waiting_user", [T0]);
  const { rt } = rtOf();
  expect(sweepItemAge(rt, T0 + 7 * H)).toBe(0);
  expect(sweepItemAge(rt, T0 + 9 * H)).toBe(1);
  expect(getItem(db, "it")?.status).toBe("blocked");
});

test("running item past 8 h: the live run is aborted with item_age; the policy holds it as a REAL failure (no auto-resume) with a failure event", () => {
  setup("running", [T0]);
  const ac = new AbortController();
  cleanup.push(
    registerRun({
      kind: "worker",
      taskId: "it",
      threadId: "th",
      turnId: "tn0",
      role: "developer",
      ac,
    }),
  );
  const { rt } = rtOf();
  expect(sweepItemAge(rt, T0 + 8 * H + 60_000)).toBe(1);
  expect(ac.signal.aborted).toBe(true);
  expect(getItem(db, "it")?.status).toBe("running"); // the run's own end settles it
  expect(sweepItemAge(rt, T0 + 8 * H + 120_000)).toBe(0); // already aborted: left to the run's end
  // The run's end: what worker-run does with the cause it reads from the live run.
  const verdict = applyFailurePolicy({
    db,
    itemId: "it",
    turnId: "tn0",
    res: { text: "", outcome: "aborted", sessionId: "s" },
    status: "cancelled",
    stopping: false,
    abortCause: "item_age",
  });
  expect(verdict).toMatchObject({ action: "hold", class: "real", cause: "item_age" });
  emitEndEvent(db, "th", "it", "tn0", undefined, verdict);
  const it = getItem(db, "it")!;
  expect([it.status, it.resultKind, it.attempt]).toEqual(["blocked", "FAILED", 0]);
  expect(listUndelivered(db, "th").find((e) => e.kind === "failure")?.payload).toMatchObject({
    class: "real",
    cause: "item_age",
  });
});

test("resumes do not reset the clock (MIN of the turns); a recent resume turn does not save the item", () => {
  setup("running", [T0, T0 + 3 * H, T0 + 7 * H]);
  expect(aged(T0 + 8 * H - 1)).toEqual([]);
  expect(aged(T0 + 8 * H + 1)).toEqual(["it"]);
});

test("RetryTask resets the clock: the new retry event starts a fresh 8 h (also for the old turns); a new turn after it is the new start", () => {
  setup("blocked", [T0]);
  db.query("UPDATE owned_tasks SET result_kind = 'FAILED' WHERE id = 'it'").run();
  const retryAt = Date.now(); // the port stamps events and the ready move with the real clock
  expect(createRetryPort(db, "th").retry("it", "fix it")).toBe("ok");
  expect(getItem(db, "it")?.status).toBe("ready");
  expect(aged(retryAt + ITEM_MAX_AGE_MS - 5_000)).toEqual([]); // old turn at T0 would be long over 8 h
  expect(aged(retryAt + ITEM_MAX_AGE_MS + 5_000)).toEqual(["it"]);
  // The retried run starts a turn 2 h later: that start is the clock, later turns never move it.
  addTurn("tn-retry", retryAt + 2 * H);
  addTurn("tn-resume", retryAt + 5 * H);
  expect(aged(retryAt + 2 * H + ITEM_MAX_AGE_MS - 5_000)).toEqual([]);
  expect(aged(retryAt + 2 * H + ITEM_MAX_AGE_MS + 5_000)).toEqual(["it"]);
});

test("restart: a new db handle over the same file keeps the clock", () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-age-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "db.sqlite");
  const first = openDb(file);
  setup("running", [T0], first);
  first.close();
  db = openDb(file);
  expect(aged(T0 + 8 * H + 1)).toEqual(["it"]);
  expect(aged(T0 + 8 * H - 1)).toEqual([]);
});

test("the ready clock is last_progress_at, stamped by the move to ready (pins the assumption of item-age-store)", () => {
  setup("pending");
  const before = Date.now();
  moveTaskTo(db, "it", "ready");
  const stamped = db
    .query<{ t: number }, []>("SELECT last_progress_at AS t FROM owned_tasks WHERE id = 'it'")
    .get()!.t;
  expect(stamped).toBeGreaterThanOrEqual(before);
});

test("the 15 min stale abort stays transient (resume), item_age is real; neither is an age hit at 15 min", () => {
  expect(classifyRunFailure({ outcome: "aborted", abortCause: "stale" })).toEqual({
    class: "transient",
    cause: "stale",
  });
  expect(classifyRunFailure({ outcome: "aborted", abortCause: "item_age" })).toEqual({
    class: "real",
    cause: "item_age",
  });
  expect(
    classifyRunFailure({ outcome: "aborted", abortCause: "item_age", stopping: true }).class,
  ).toBe("transient"); // a shutdown is still a restart
  setup("running", [T0]);
  expect(aged(T0 + STALE_AFTER_MS + 1)).toEqual([]);
});

test("end to end: sweep aborts a real registered run with item_age, the run's own failure policy holds it, failure event, no resume", () => {
  setup("running", [T0]);
  const ac = new AbortController();
  cleanup.push(
    registerRun({
      kind: "worker",
      taskId: "it",
      threadId: "th",
      turnId: "tn0",
      role: "developer",
      ac,
    }),
  );
  const { rt } = rtOf();
  sweepItemAge(rt, T0 + 8 * H + 1);
  expect(ac.signal.aborted).toBe(true);
  expect(runOfTask("it")?.abortCause).toBe("item_age");
  // The run's closeTurn hook reads the cause from the still-registered live run, as in worker-run.
  const verdict: { current?: FailureVerdict } = {};
  const close = workerFailurePolicy({
    db,
    itemId: "it",
    turnId: "tn0",
    resultKind: () => undefined,
    stopping: () => false,
    verdict,
  });
  expect(close({ text: "", outcome: "aborted", sessionId: "s" }, "cancelled")).toBe(true);
  emitEndEvent(db, "th", "it", "tn0", undefined, verdict.current);
  const it = getItem(db, "it")!;
  expect([it.status, it.resultKind, it.attempt]).toEqual(["blocked", "FAILED", 0]);
  expect(waitMs("it")).toBe(0); // no resume backoff entry: nothing will start it again
  const failures = listUndelivered(db, "th").filter((e) => e.kind === "failure");
  expect(failures).toHaveLength(1);
  expect(failures[0]!.payload).toMatchObject({ class: "real", cause: "item_age", attempt: 0 });
  expect(sweepItemAge(rt, T0 + 9 * H)).toBe(0);
});

test("a held item cannot be started by anything but RetryTask: a stale ready snapshot and an owner answer both leave it blocked", async () => {
  setup("ready");
  const stale = getItem(db, "it")!; // the pass read it as ready ...
  const { rt } = rtOf();
  sweepItemAge(rt, T0 + 9 * H); // ... then the age limit held it
  const limiter = createRunLimiter(1);
  const full = {
    deps: { db, limiter },
    relay: createQuestionRelay(db, () => {}),
  } as unknown as LeadRuntime;
  expect(await startWorker(full, {} as never, "th", stale, () => {})).toBe(true); // skipped, nothing to retry later
  expect(limiter.active()).toBe(0); // slot given back
  expect(db.query("SELECT COUNT(*) AS n FROM turns WHERE owned_task_id = 'it'").get()).toEqual({
    n: 0,
  });
  expect(full.relay.answer("it", "yes, go on")).toBe(false); // nobody waits: an answer moves nothing
  const it = getItem(db, "it")!;
  expect([it.status, it.resultKind]).toEqual(["blocked", "FAILED"]);
  // Only RetryTask releases it.
  expect(createRetryPort(db, "th").retry("it", "again")).toBe("ok");
  expect(getItem(db, "it")?.status).toBe("ready");
});
