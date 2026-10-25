import { expect, test } from "bun:test";
import type { NewSchedule } from "../../src/schedules/schedule-board";
import { makeHub } from "../bot-hub-harness";
import { addSchedule, DAY, fakeNextRunAt, HOUR, MIN, makeBoard, T0 } from "./schedule-harness";

const input = (over: Partial<NewSchedule> = {}): NewSchedule => ({
  name: "Brief",
  botId: "editor",
  task: "Write the brief.",
  rule: { kind: "daily", at: "07:30" },
  conversationId: "dc",
  ...over,
});

test("create stores the schedule with the default zone, notify and the next run", async () => {
  const h = makeBoard();
  const r = await h.board.create(input(), { kind: "user" });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.schedule).toMatchObject({
    name: "Brief",
    timeZone: "UTC",
    notify: "always",
    enabled: true,
    nextRunAt: T0 + 7 * HOUR + 30 * MIN,
    createdBy: { kind: "user" },
    createdAt: T0,
  });
  expect(await h.board.get(r.schedule.id)).toEqual(r.schedule);
  expect(h.changes).toEqual([r.schedule.id]);
});

test("create refuses bad rules, zones, names, tasks, bots and targets", async () => {
  const h = makeBoard();
  const bad: Partial<NewSchedule>[] = [
    { rule: { kind: "interval", every: 5, unit: "minutes" } },
    { timeZone: "Mars/Base" },
    { name: "  " },
    { name: "x".repeat(81) },
    { task: "" },
    { task: "x".repeat(4001) },
    { botId: "ghost" },
    { botId: "loner", conversationId: "gc" },
    { conversationId: "dw" },
    { conversationId: "nowhere" },
  ];
  for (const b of bad) {
    const r = await h.board.create(input(b), { kind: "user" });
    expect(r).toMatchObject({ ok: false, code: "invalid" });
  }
  expect(await h.board.list()).toEqual([]);
  expect(h.changes).toEqual([]);
});

test("create accepts a group target when the bot is a member", async () => {
  const h = makeBoard();
  const r = await h.board.create(input({ conversationId: "gc" }), { kind: "user" });
  expect(r.ok).toBe(true);
});

test("a once already past, or a date with no next run, is invalid", async () => {
  const h = makeBoard();
  const past = await h.board.create(
    input({ rule: { kind: "once", date: "2026-10-24", at: "08:00" } }),
    {
      kind: "user",
    },
  );
  expect(past).toEqual({ ok: false, code: "invalid", error: "That time is already past." });
  // 31 Feb passes the date pattern, but there is no such day: no next run.
  const none = await h.board.create(
    input({ rule: { kind: "once", date: "2027-02-31", at: "08:00" } }),
    {
      kind: "user",
    },
  );
  expect(none).toEqual({
    ok: false,
    code: "invalid",
    error: "That date does not exist or is already past.",
  });
});

test("a non-once rule with no next run is invalid", async () => {
  const h = makeBoard({ nextRunAt: () => undefined });
  const r = await h.board.create(input(), { kind: "user" });
  expect(r).toMatchObject({ ok: false, code: "invalid" });
});

test("update: a new rule recomputes the next run from now; the zone never changes", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  h.clock.advance(HOUR);
  const r = await h.board.update(s.id, { rule: { kind: "interval", every: 2, unit: "hours" } });
  expect(r.ok && r.schedule.nextRunAt).toBe(T0 + 3 * HOUR);
  expect(r.ok && r.schedule.timeZone).toBe("UTC");
  expect(r.ok && r.schedule.updatedAt).toBe(T0 + HOUR);
  const tz = await h.board.update(s.id, { timeZone: "Asia/Saigon" } as never);
  expect(tz.ok && tz.schedule.timeZone).toBe("UTC");
});

test("update: disable clears the next run; enable recomputes it and clears the reason", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  const off = await h.board.update(s.id, { enabled: false });
  expect(off.ok && off.schedule.enabled).toBe(false);
  expect(off.ok && "nextRunAt" in off.schedule && off.schedule.nextRunAt).toBeFalsy();
  await h.store.schedules.update(s.id, { disabledReason: "bot_gone" });
  h.clock.advance(DAY);
  const on = await h.board.update(s.id, { enabled: true });
  expect(on.ok && on.schedule.nextRunAt).toBe(T0 + DAY + 7 * HOUR + 30 * MIN);
  expect(on.ok && on.schedule.disabledReason).toBeUndefined();
  expect(on.ok && on.schedule.enabled).toBe(true);
});

test("update refuses bad fields and a rule with no next run", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  for (const p of [
    { name: "" },
    { task: "x".repeat(4001) },
    { rule: { kind: "daily" as const, at: "7:30" } },
    { rule: { kind: "once" as const, date: "2027-02-31", at: "08:00" } },
    { notify: "loud" as never },
  ]) {
    expect(await h.board.update(s.id, p)).toMatchObject({ ok: false, code: "invalid" });
  }
  expect((await h.board.get(s.id))?.name).toBe("Brief");
});

test("scope limits get, list, update and remove to the bot and its group conversation", async () => {
  const h = makeBoard();
  const direct = await addSchedule(h);
  const group = await addSchedule(h, undefined, { conversationId: "gc" });
  const mine = await addSchedule(h, undefined, { botId: "writer", conversationId: "dw" });
  expect((await h.board.list({ botId: "editor" })).map((s) => s.id)).toEqual([direct.id, group.id]);
  expect((await h.board.list({ botId: "editor", conversationId: "gc" })).map((s) => s.id)).toEqual([
    group.id,
  ]);
  expect(await h.board.get(mine.id, { botId: "editor" })).toBeUndefined();
  expect(await h.board.get(direct.id, { botId: "editor", conversationId: "gc" })).toBeUndefined();
  expect(await h.board.update(mine.id, { name: "x" }, { botId: "editor" })).toMatchObject({
    ok: false,
    code: "not_found",
  });
  expect(await h.board.remove(mine.id, { botId: "editor" })).toMatchObject({ code: "not_found" });
  expect(await h.board.remove(direct.id, { botId: "editor" })).toEqual({ ok: true });
  expect(await h.board.get(direct.id)).toBeUndefined();
  expect(await h.board.remove("nope")).toMatchObject({ code: "not_found" });
  expect(h.changes.filter((id) => id === direct.id)).toHaveLength(2);
});

test("a listener that throws never breaks a change", async () => {
  const h = makeBoard({
    onChange: () => {
      throw new Error("boom");
    },
  });
  const s = await addSchedule(h);
  expect((await h.board.update(s.id, { name: "New" })).ok).toBe(true);
});

test("a hub without nextRunAt has a board whose create is refused", async () => {
  const h = makeHub();
  const r = await h.hub.schedules.create(input(), { kind: "user" });
  expect(r).toEqual({ ok: false, code: "invalid", error: "Schedules are not available." });
});

test("a hub with nextRunAt creates schedules and tells onScheduleChange", async () => {
  const seen: string[] = [];
  const h = makeHub(undefined, {
    nextRunAt: fakeNextRunAt,
    onScheduleChange: (id) => seen.push(id),
  });
  const r = await h.hub.schedules.create(input(), { kind: "user" });
  expect(r.ok).toBe(true);
  expect(seen).toEqual([r.ok ? r.schedule.id : ""]);
});
