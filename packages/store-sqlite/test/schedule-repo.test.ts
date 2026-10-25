import { expect, test } from "bun:test";
import type { Schedule, ScheduleRun } from "@friday/core";
import { openEngineStore } from "../src/engine-store";

/** A schedule row; tests override what they need. */
const sched = (id: string, over: Partial<Schedule> = {}): Schedule => ({
  id,
  name: `name ${id}`,
  botId: "b1",
  task: "do it",
  rule: { kind: "weekly", at: "09:30", weekday: 2 },
  timeZone: "Asia/Ho_Chi_Minh",
  conversationId: "bot:b1",
  notify: "always",
  enabled: true,
  nextRunAt: 1000,
  createdBy: { kind: "bot", botId: "b1" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/** A run row; tests override what they need. */
const run = (id: string, over: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id,
  scheduleId: "s1",
  dueAt: 1,
  firedAt: 1,
  manual: false,
  late: false,
  status: "running",
  costUsd: 0,
  ...over,
});

test("insert then get round-trips every field", async () => {
  const s = openEngineStore(":memory:");
  const full = sched("s1", { lastFireAt: 500, disabledReason: "done", enabled: false });
  await s.schedules.insert(full);
  expect(await s.schedules.get("s1")).toEqual(full);
  await s.schedules.insert(sched("s2", { nextRunAt: undefined }));
  expect((await s.schedules.get("s2"))?.nextRunAt).toBeUndefined();
  expect(await s.schedules.get("nope")).toBeUndefined();
});

test("list filters by bot and conversation, ordered by createdAt", async () => {
  const s = openEngineStore(":memory:");
  await s.schedules.insert(sched("a", { createdAt: 3 }));
  await s.schedules.insert(sched("b", { createdAt: 2, botId: "b2", conversationId: "group:g" }));
  await s.schedules.insert(sched("c", { createdAt: 1 }));
  expect((await s.schedules.list()).map((x) => x.id)).toEqual(["c", "b", "a"]);
  expect((await s.schedules.list({ botId: "b1" })).map((x) => x.id)).toEqual(["c", "a"]);
  expect((await s.schedules.list({ conversationId: "group:g" })).map((x) => x.id)).toEqual(["b"]);
});

test("update patches fields and returns the row", async () => {
  const s = openEngineStore(":memory:");
  await s.schedules.insert(sched("s1"));
  const got = await s.schedules.update("s1", { name: "new", notify: "problems", updatedAt: 9 });
  expect(got).toMatchObject({ name: "new", notify: "problems", updatedAt: 9, task: "do it" });
  expect(await s.schedules.update("nope", { name: "x" })).toBeUndefined();
});

test("due returns only enabled rows with nextRunAt <= now", async () => {
  const s = openEngineStore(":memory:");
  await s.schedules.insert(sched("due", { nextRunAt: 100 }));
  await s.schedules.insert(sched("later", { nextRunAt: 200 }));
  await s.schedules.insert(sched("off", { nextRunAt: 100, enabled: false }));
  await s.schedules.insert(sched("none", { nextRunAt: undefined }));
  expect((await s.schedules.due(150)).map((x) => x.id)).toEqual(["due"]);
});

test("advance is a compare-and-set on nextRunAt", async () => {
  const s = openEngineStore(":memory:");
  await s.schedules.insert(sched("s1"));
  expect(await s.schedules.advance("s1", 1000, { nextRunAt: 2000, lastFireAt: 1000 })).toBe(true);
  expect(await s.schedules.advance("s1", 1000, { nextRunAt: 3000 })).toBe(false);
  expect(await s.schedules.get("s1")).toMatchObject({ nextRunAt: 2000, lastFireAt: 1000 });
});

test("an explicit undefined clears a column; an absent key leaves it", async () => {
  const s = openEngineStore(":memory:");
  await s.schedules.insert(sched("s1", { lastFireAt: 5 }));
  // Disable: nextRunAt cleared, lastFireAt (absent) kept.
  await s.schedules.update("s1", { enabled: false, nextRunAt: undefined, disabledReason: "done" });
  expect(await s.schedules.get("s1")).toMatchObject({ enabled: false, lastFireAt: 5 });
  expect((await s.schedules.get("s1"))?.nextRunAt).toBeUndefined();
  // Enable: disabledReason cleared.
  await s.schedules.update("s1", { enabled: true, nextRunAt: 7000, disabledReason: undefined });
  const on = await s.schedules.get("s1");
  expect(on).toMatchObject({ enabled: true, nextRunAt: 7000 });
  expect(on?.disabledReason).toBeUndefined();
  // advance clears the same way.
  expect(await s.schedules.advance("s1", 7000, { nextRunAt: undefined, enabled: false })).toBe(
    true,
  );
  expect((await s.schedules.get("s1"))?.nextRunAt).toBeUndefined();
});

test("advance with an empty patch is a plain compare and does not throw", async () => {
  const s = openEngineStore(":memory:");
  await s.schedules.insert(sched("s1"));
  expect(await s.schedules.advance("s1", 1000, {})).toBe(true);
  expect(await s.schedules.advance("s1", 999, {})).toBe(false);
  expect(await s.schedules.advance("nope", 1000, {})).toBe(false);
});

test("remove deletes the schedule and its runs", async () => {
  const s = openEngineStore(":memory:");
  await s.schedules.insert(sched("s1"));
  await s.schedules.insert(sched("s2"));
  await s.scheduleRuns.insert(run("r1"));
  await s.scheduleRuns.insert(run("r2", { scheduleId: "s2" }));
  expect(await s.schedules.remove("s1")).toBe(true);
  expect(await s.schedules.remove("s1")).toBe(false);
  expect(await s.scheduleRuns.list("s1", 10)).toEqual([]);
  expect(await s.scheduleRuns.list("s2", 10)).toHaveLength(1);
});

test("disabledBefore lists disabled rows of the reasons updated before the time", async () => {
  const s = openEngineStore(":memory:");
  const off = { enabled: false, updatedAt: 10 };
  await s.schedules.insert(sched("done", { ...off, disabledReason: "done" }));
  await s.schedules.insert(sched("gone", { ...off, disabledReason: "bot_gone" }));
  await s.schedules.insert(sched("new", { enabled: false, updatedAt: 90, disabledReason: "done" }));
  await s.schedules.insert(sched("paused", off));
  expect((await s.schedules.disabledBefore(["done", "group_gone"], 50)).map((x) => x.id)).toEqual([
    "done",
  ]);
  expect(await s.schedules.disabledBefore([], 50)).toEqual([]);
  expect((await s.schedules.list()).map((x) => x.id).sort()).toEqual([
    "done",
    "gone",
    "new",
    "paused",
  ]);
});

test("runs: update, open, addCost, list newest first, deleteBefore", async () => {
  const s = openEngineStore(":memory:");
  await s.scheduleRuns.insert(run("r1", { firedAt: 10, wakeId: "w1" }));
  await s.scheduleRuns.insert(run("r2", { firedAt: 20, wakeId: "w2" }));
  await s.scheduleRuns.insert(run("r3", { firedAt: 30, status: "ok" }));
  expect((await s.scheduleRuns.open()).map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  await s.scheduleRuns.addCost("w1", 0.02);
  await s.scheduleRuns.addCost("w1", 0.02);
  await s.scheduleRuns.addCost("none", 1);
  await s.scheduleRuns.update("r1", { status: "problem", endedAt: 15, error: "boom" });
  const list = await s.scheduleRuns.list("s1", 2);
  expect(list.map((r) => r.id)).toEqual(["r3", "r2"]);
  expect((await s.scheduleRuns.list("s1", 10, 30)).map((r) => r.id)).toEqual(["r2", "r1"]);
  const r1 = (await s.scheduleRuns.list("s1", 10)).find((r) => r.id === "r1");
  expect(r1).toMatchObject({ costUsd: 0.04, status: "problem", endedAt: 15, error: "boom" });
  expect(await s.scheduleRuns.deleteBefore(25)).toBe(2);
});

test("runs: latest gives the newest run of each asked schedule, by firedAt", async () => {
  const s = openEngineStore(":memory:");
  await s.scheduleRuns.insert(run("a1", { scheduleId: "a", firedAt: 10 }));
  await s.scheduleRuns.insert(run("a2", { scheduleId: "a", firedAt: 30 }));
  await s.scheduleRuns.insert(run("a3", { scheduleId: "a", firedAt: 20 }));
  await s.scheduleRuns.insert(run("b1", { scheduleId: "b", firedAt: 5, status: "ok" }));
  await s.scheduleRuns.insert(run("c1", { scheduleId: "c", firedAt: 99 }));
  const latest = await s.scheduleRuns.latest(["a", "b", "none"]);
  expect([...latest.keys()].sort()).toEqual(["a", "b"]);
  expect(latest.get("a")?.id).toBe("a2");
  expect(latest.get("b")).toMatchObject({ id: "b1", status: "ok" });
  expect((await s.scheduleRuns.latest([])).size).toBe(0);
});
