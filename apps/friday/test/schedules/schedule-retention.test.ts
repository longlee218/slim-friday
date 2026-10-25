import { expect, test } from "bun:test";
import type { Schedule, ScheduleRun } from "@friday/core";
import { openEngineStore } from "@friday/store-sqlite";
import { pruneSchedules } from "../../src/schedules/schedule-retention";

const DAY = 86_400_000;
const NOW = 200 * DAY;

const sched = (id: string, over: Partial<Schedule>): Schedule => ({
  id,
  name: id,
  botId: "b1",
  task: "t",
  rule: { kind: "daily", at: "09:00" },
  timeZone: "UTC",
  conversationId: "bot:b1",
  notify: "always",
  enabled: true,
  nextRunAt: 1,
  createdBy: { kind: "bot", botId: "b1" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const run = (id: string, ageDays: number): ScheduleRun => ({
  id,
  scheduleId: "live",
  dueAt: 1,
  firedAt: NOW - ageDays * DAY,
  manual: false,
  late: false,
  status: "ok",
  costUsd: 0,
});

test("prune drops 91-day-old runs and schedules disabled bot_gone 9 days ago, keeps newer", async () => {
  const s = openEngineStore(":memory:");
  await s.schedules.insert(sched("live", {}));
  await s.schedules.insert(
    sched("gone9", { enabled: false, disabledReason: "bot_gone", updatedAt: NOW - 9 * DAY }),
  );
  await s.schedules.insert(
    sched("gone5", { enabled: false, disabledReason: "bot_gone", updatedAt: NOW - 5 * DAY }),
  );
  await s.scheduleRuns.insert(run("old", 91));
  await s.scheduleRuns.insert(run("fresh", 89));
  await pruneSchedules(s, NOW);
  expect((await s.schedules.list()).map((x) => x.id).sort()).toEqual(["gone5", "live"]);
  expect((await s.scheduleRuns.list("live", 10)).map((r) => r.id)).toEqual(["fresh"]);
});
