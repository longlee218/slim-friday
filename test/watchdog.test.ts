import type { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { STALE_AFTER_MS, SWEEP_TICK_MS } from "../src/config/resilience-caps";
import type { LeadRuntime } from "../src/orchestrator/lead/lead-runtime";
import { type LiveRun, registerRun } from "../src/orchestrator/run/live-runs";
import { startResilienceSweeper } from "../src/orchestrator/worker/resilience-sweeper";
import { setWaiting, touch } from "../src/orchestrator/worker/run-activity";
import { pickStale, sweepStale } from "../src/orchestrator/worker/watchdog";
import { openDb } from "../src/storage/db";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { listUndelivered } from "../src/storage/thread-event-store";

/* The watchdog: pure pick (idle > threshold, skips waiting and lead), the sweep (abort cause, no event: the failure policy resumes the item). */

let db: Database;
const settles: (() => void)[] = [];
afterEach(() => {
  for (const s of settles.splice(0)) s();
  db?.close();
  db = undefined as never; // a fresh db per test
});

const run = (over: Partial<LiveRun>): LiveRun => ({
  key: "k",
  kind: "worker",
  threadId: "t",
  role: "developer",
  ac: new AbortController(),
  seq: 0,
  lastActivityAt: 0,
  ...over,
});
const after = () => STALE_AFTER_MS;

test("pickStale: a worker idle longer than the threshold; not at the threshold, not waiting, not lead, not twice", () => {
  const now = 10_000_000;
  const idle = run({ key: "a", lastActivityAt: now - STALE_AFTER_MS - 1 });
  expect(pickStale([idle], now, after)).toEqual([idle]);
  expect(pickStale([run({ lastActivityAt: now - STALE_AFTER_MS })], now, after)).toEqual([]);
  expect(pickStale([{ ...idle, waitingCount: 1 }], now, after)).toEqual([]);
  expect(pickStale([{ ...idle, kind: "lead" }], now, after)).toEqual([]);
  expect(pickStale([{ ...idle, abortCause: "stale" }], now, after)).toEqual([]);
  // Already aborted by anyone else (/stop, shutdown, replaced): skipped.
  const stopped = new AbortController();
  stopped.abort();
  expect(pickStale([{ ...idle, ac: stopped }], now, after)).toEqual([]);
  // A per-run threshold wins over the default.
  expect(pickStale([idle], now, () => STALE_AFTER_MS * 2)).toEqual([]);
});

/** A worker run over a real item row, plus a runtime that records wakes. */
function setup(id: string) {
  db ??= openDb(":memory:");
  insertOwnedTask(db, {
    id,
    threadId: "th1",
    ownerRole: "developer",
    status: "running",
    scope: "s",
    correlationId: "c",
  });
  const ac = new AbortController();
  settles.push(
    registerRun({
      kind: "worker",
      taskId: id,
      threadId: "th1",
      turnId: `turn-${id}`,
      role: "developer",
      ac,
    }),
  );
  const woken: string[] = [];
  const rt = {
    deps: { db },
    announce: (t: string) => void woken.push(t),
  } as unknown as LeadRuntime;
  return { ac, rt, woken };
}

test("sweepStale: aborts a stale run (cause stale) with no timeout event and no wake: the policy resumes it; a second sweep adds nothing", () => {
  const { ac, rt, woken } = setup("wd-1");
  const t = Date.now() + STALE_AFTER_MS + 1000;
  expect(sweepStale(rt, t - 2000)).toHaveLength(0); // still fresh
  const hit = sweepStale(rt, t);
  expect(hit).toHaveLength(1);
  expect(ac.signal.aborted).toBe(true);
  expect(hit[0]?.abortCause).toBe("stale");
  expect(listUndelivered(db, "th1")).toHaveLength(0); // the lead does nothing: code resumes the item
  expect(woken).toEqual([]);
  expect(sweepStale(rt, t + 1000)).toHaveLength(0);
});

test("a run that touches stays alive; a waiting run is skipped until it leaves the wait", () => {
  const { ac, rt } = setup("wd-2");
  const t0 = Date.now();
  touch(db, "wd-2", t0 + STALE_AFTER_MS - 1000); // heartbeat just before the threshold
  expect(sweepStale(rt, t0 + STALE_AFTER_MS + 5000)).toHaveLength(0);
  setWaiting(db, "wd-2", true);
  expect(sweepStale(rt, t0 + STALE_AFTER_MS * 10)).toHaveLength(0);
  expect(ac.signal.aborted).toBe(false);
  setWaiting(db, "wd-2", false); // activity is now (real clock): fresh again
  expect(sweepStale(rt, Date.now() + 1000)).toHaveLength(0);
});

test("detection latency: a run silent from t0 is aborted by the first tick after t0 + threshold (fake clock)", () => {
  const { ac, rt } = setup("wd-3");
  const t0 = Date.now();
  let aborted: number | undefined;
  for (
    let t = t0;
    t <= t0 + STALE_AFTER_MS + SWEEP_TICK_MS && aborted === undefined;
    t += SWEEP_TICK_MS
  ) {
    sweepStale(rt, t);
    if (ac.signal.aborted) aborted = t;
  }
  expect(aborted).toBeDefined();
  expect((aborted as number) - t0).toBeLessThanOrEqual(STALE_AFTER_MS + SWEEP_TICK_MS);
});

test("the sweeper timer is unref'd and stoppable", () => {
  const { rt } = setup("wd-4");
  const stop = startResilienceSweeper(rt, 10_000);
  stop();
  stop(); // idempotent
});

test("sweepStale appends no event for an item that already ended (the run had not settled yet)", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    const id = `wd-end-${status}`;
    const { ac, rt, woken } = setup(id);
    db.query("UPDATE owned_tasks SET status = ? WHERE id = ?").run(status, id);
    expect(sweepStale(rt, Date.now() + STALE_AFTER_MS + 1000)).toHaveLength(1);
    expect(ac.signal.aborted).toBe(true);
    expect(listUndelivered(db, "th1").filter((e) => e.itemId === id)).toHaveLength(0);
    expect(woken).toEqual([]);
  }
});

test("the sweeper timer calls sweepStale on every tick", () => {
  const { ac, rt } = setup("wd-tick");
  let tick!: () => void;
  const real = globalThis.setInterval;
  const spy = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
    expect(ms).toBe(SWEEP_TICK_MS);
    tick = fn;
    return real(() => {}, 1_000_000);
  }) as never);
  const stop = startResilienceSweeper(rt);
  spy.mockRestore();
  tick(); // the run is fresh: nothing happens
  expect(ac.signal.aborted).toBe(false);
  const realNow = Date.now;
  Date.now = () => realNow() + STALE_AFTER_MS + 1000;
  try {
    tick(); // the run is now silent for longer than the threshold
  } finally {
    Date.now = realNow;
  }
  expect(ac.signal.aborted).toBe(true);
  stop();
});
