import { expect, test } from "bun:test";
import type { Bot, Group, Schedule, ScheduleRun } from "@friday/core";
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

/** The engine db plus bots and groups the test names. */
function storeWith(bots: string[], groups: string[] = []) {
  const engine = openEngineStore(":memory:");
  return Object.assign(engine, {
    bots: {
      get: async (id: string) => (bots.includes(id) ? ({ id } as Bot) : undefined),
      list: async () => [],
    },
    groups: {
      get: async (id: string) => (groups.includes(id) ? ({ id } as Group) : undefined),
    },
  });
}

const gone = (
  reason: "bot_gone" | "group_gone",
  ageDays: number,
  over: Partial<Schedule> = {},
) => ({
  enabled: false,
  disabledReason: reason,
  updatedAt: NOW - ageDays * DAY,
  ...over,
});

test("prune drops 91-day-old runs and schedules whose bot is still gone after 8 days", async () => {
  const s = storeWith([]);
  await s.schedules.insert(sched("live", {}));
  await s.schedules.insert(sched("gone9", gone("bot_gone", 9)));
  await s.schedules.insert(sched("gone7", gone("bot_gone", 7)));
  await s.scheduleRuns.insert(run("old", 91));
  await s.scheduleRuns.insert(run("fresh", 89));
  await pruneSchedules(s, NOW);
  expect((await s.schedules.list()).map((x) => x.id).sort()).toEqual(["gone7", "live"]);
  expect((await s.scheduleRuns.list("live", 10)).map((r) => r.id)).toEqual(["fresh"]);
});

test("prune keeps an old bot_gone schedule whose bot was restored", async () => {
  const s = storeWith(["b1"]);
  await s.schedules.insert(sched("back", gone("bot_gone", 9)));
  await pruneSchedules(s, NOW);
  expect((await s.schedules.list()).map((x) => x.id)).toEqual(["back"]);
});

test("prune removes an old group_gone schedule only while its group is missing", async () => {
  const s = storeWith(["b1"], ["g1"]);
  await s.conversations.put({ id: "group:g1", kind: "group", groupId: "g1" });
  await s.conversations.put({ id: "group:g2", kind: "group", groupId: "g2" });
  await s.schedules.insert(sched("here", gone("group_gone", 9, { conversationId: "group:g1" })));
  await s.schedules.insert(sched("nogroup", gone("group_gone", 9, { conversationId: "group:g2" })));
  await s.schedules.insert(sched("noconv", gone("group_gone", 9, { conversationId: "group:g3" })));
  await pruneSchedules(s, NOW);
  expect((await s.schedules.list()).map((x) => x.id)).toEqual(["here"]);
});
