import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { ACTIVITY_PERSIST_MS, STALE_AFTER_MS } from "../src/config/resilience-caps";
import { type LiveRun, liveWorkers, registerRun } from "../src/orchestrator/run/live-runs";
import {
  progressOf,
  setProgress,
  setWaiting,
  touch,
  withWaiting,
} from "../src/orchestrator/worker/run-activity";
import { pickStale } from "../src/orchestrator/worker/watchdog";
import { openDb } from "../src/storage/db";
import { getOwnedTask, insertOwnedTask, touchProgress } from "../src/storage/owned-task-store";

/* Activity of a worker run: in-memory stamp, throttled db write (no version bump), progress facts, waiting flag. */

let db: Database;
const settles: (() => void)[] = [];
afterEach(() => {
  for (const s of settles.splice(0)) s();
  db?.close();
  db = undefined as never; // a fresh db per test
});

/** A live worker run over a real owned task row. */
function live(id: string, kind: "worker" | "lead" = "worker") {
  db ??= openDb(":memory:");
  insertOwnedTask(db, {
    id,
    threadId: "th1",
    ownerRole: "developer",
    status: "running",
    scope: "s",
    correlationId: "c",
  });
  const settle =
    kind === "worker"
      ? registerRun({
          kind,
          taskId: id,
          threadId: "th1",
          turnId: `turn-${id}`,
          role: "developer",
          ac: new AbortController(),
        })
      : registerRun({ kind, threadId: "th1", role: "lead", ac: new AbortController() });
  settles.push(settle);
}

test("touch stamps the run and writes the db at most once per throttle window, without a version bump", () => {
  live("ra-1");
  const v0 = getOwnedTask(db, "ra-1")?.version;
  const t0 = Date.now() + 10_000;
  touch(db, "ra-1", t0);
  const first = Date.parse(getOwnedTask(db, "ra-1")?.lastProgressAt as string);
  expect(first).toBe(t0);
  touch(db, "ra-1", t0 + 1000); // inside the window: memory only
  expect(Date.parse(getOwnedTask(db, "ra-1")?.lastProgressAt as string)).toBe(t0);
  expect(progressOf("ra-1", t0 + 1000)?.idleSeconds).toBe(0);
  touch(db, "ra-1", t0 + ACTIVITY_PERSIST_MS); // window over: written again
  expect(Date.parse(getOwnedTask(db, "ra-1")?.lastProgressAt as string)).toBe(
    t0 + ACTIVITY_PERSIST_MS,
  );
  expect(getOwnedTask(db, "ra-1")?.version).toBe(v0);
});

test("setProgress keeps percent and a redacted, clipped note; progressOf reads it by task id or turn id", () => {
  live("ra-2");
  const now = Date.now();
  setProgress(db, "ra-2", { percent: 40, note: `  step\n two ${"x".repeat(400)}` }, now);
  const p = progressOf("turn-ra-2", now + 5000);
  expect(p?.percent).toBe(40);
  expect(p?.note?.length).toBeLessThanOrEqual(200);
  expect(p?.note?.startsWith("step two")).toBe(true);
  expect(p?.idleSeconds).toBe(5);
});

test("setWaiting flips the flag; leaving the wait counts as activity", () => {
  live("ra-3");
  setWaiting(db, "ra-3", true);
  expect(progressOf("ra-3")).toBeDefined();
  setWaiting(db, "ra-3", false);
  expect(progressOf("ra-3")?.idleSeconds).toBe(0);
});

test("a run that is not live, or is the lead's, is ignored (no throw)", () => {
  live("ra-4", "lead");
  touch(db, "ghost");
  setProgress(db, "ghost", { percent: 1, note: "n" });
  setWaiting(db, "ghost", true);
  expect(progressOf("ghost")).toBeUndefined();
  expect(progressOf("lead:th1")).toBeUndefined();
});

test("waits are a counter: two parallel confirms, the first closes, the run is still skipped by the watchdog", async () => {
  live("ra-5");
  const run = liveWorkers().find((r) => r.taskId === "ra-5") as LiveRun;
  run.lastActivityAt = 0;
  let release1!: () => void;
  let release2!: () => void;
  const a = withWaiting(db, "ra-5", () => new Promise<void>((r) => (release1 = r)));
  const b = withWaiting(db, "ra-5", () => new Promise<void>((r) => (release2 = r)));
  expect(run.waitingCount).toBe(2);
  release1();
  await a;
  expect(run.waitingCount).toBe(1);
  expect(run.lastActivityAt).toBe(0); // not the last wait: no activity stamp
  expect(pickStale([run], STALE_AFTER_MS + 1, () => STALE_AFTER_MS)).toEqual([]);
  release2();
  await b;
  expect(run.waitingCount).toBe(0);
  expect(run.lastActivityAt).toBeGreaterThan(0); // the last wait closed: counts as activity
});

test("withWaiting closes its wait when the wrapped call throws", async () => {
  live("ra-6");
  const run = liveWorkers().find((r) => r.taskId === "ra-6") as LiveRun;
  await expect(
    withWaiting(db, "ra-6", async () => {
      throw new Error("confirm failed");
    }),
  ).rejects.toThrow("confirm failed");
  expect(run.waitingCount).toBe(0);
});

test("touchProgress never writes a final task", () => {
  live("ra-7");
  for (const status of ["completed", "failed", "cancelled"]) {
    db.query("UPDATE owned_tasks SET status = ?, last_progress_at = 5 WHERE id = 'ra-7'").run(
      status,
    );
    touchProgress(db, "ra-7", 999);
    expect(Date.parse(getOwnedTask(db, "ra-7")?.lastProgressAt as string)).toBe(5);
  }
  db.query("UPDATE owned_tasks SET status = 'running' WHERE id = 'ra-7'").run();
  touchProgress(db, "ra-7", 999);
  expect(Date.parse(getOwnedTask(db, "ra-7")?.lastProgressAt as string)).toBe(999);
});
