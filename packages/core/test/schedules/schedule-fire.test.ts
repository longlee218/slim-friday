import { expect, test } from "bun:test";
import { scheduleTurnText } from "../../src/schedules/schedule-turn";
import { addSchedule, DAY, HOUR, MIN, makeBoard, putWake, runsOf, T0 } from "./schedule-harness";

const AT_0730 = T0 + 7 * HOUR + 30 * MIN;

test("a due schedule fires once: advance, a running row with its wake, one run", async () => {
  const h = makeBoard();
  const s = await addSchedule(h, undefined, { notify: "problems" });
  h.clock.advance(7 * HOUR + 30 * MIN);
  await h.board.tick();
  expect(h.runsMade).toHaveLength(1);
  expect(h.runsMade[0]).toEqual({
    botId: "editor",
    conversationId: "dc",
    sender: { kind: "system" },
    text: scheduleTurnText(s, AT_0730, AT_0730),
    hop: 0,
    dedupeKey: `sched:${s.id}:2026-10-25T07:30:00.000Z`,
    opts: { schedule: { id: s.id, quiet: true } },
  });
  expect(await h.board.get(s.id)).toMatchObject({ nextRunAt: AT_0730 + DAY, lastFireAt: AT_0730 });
  const [row] = await runsOf(h, s.id);
  expect(row).toMatchObject({
    dueAt: AT_0730,
    firedAt: AT_0730,
    manual: false,
    late: false,
    status: "running",
    wakeId: "w1",
    costUsd: 0,
  });
  const fired = h.log.of("schedule.fired");
  expect(fired).toHaveLength(1);
  expect(fired[0]?.fields).toMatchObject({
    scheduleId: s.id,
    botId: "editor",
    lateMs: 0,
    manual: false,
  });
  expect(JSON.stringify(h.log.lines)).not.toContain("Write the brief.");
  // A second pass at the same time fires nothing more.
  await h.board.tick();
  expect(h.runsMade).toHaveLength(1);
});

test("scheduleTurnText: header, late note only when late, then the task", () => {
  const s = { name: "Brief", task: "Write the brief.", timeZone: "UTC" };
  expect(scheduleTurnText(s, AT_0730, AT_0730 + 14 * MIN)).toBe(
    '[Scheduled run "Brief", due Sun 25 Oct 07:30 (UTC)]\n\nWrite the brief.',
  );
  expect(scheduleTurnText(s, AT_0730, AT_0730 + HOUR)).toBe(
    '[Scheduled run "Brief", due Sun 25 Oct 07:30 (UTC)]\n' +
      "This scheduled run started late: it was due Sun 25 Oct 07:30 and started Sun 25 Oct 08:30 (UTC). " +
      "Adapt anything that depends on the time of day to the actual time, skip steps that no longer make sense, " +
      "and mention the delay when it matters to the owner.\n\nWrite the brief.",
  );
});

test("downtime: three days late fires exactly once, late, and moves to the next future 07:30", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  h.clock.advance(3 * DAY + 8 * HOUR);
  await h.board.tick();
  expect(h.runsMade).toHaveLength(1);
  expect(h.runsMade[0]?.text).toContain("started late");
  expect((await h.board.get(s.id))?.nextRunAt).toBe(AT_0730 + 4 * DAY);
  expect((await runsOf(h, s.id))[0]?.late).toBe(true);
});

test("race: a lost compare-and-set makes no row and no run", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  h.store.schedules.advance = async () => false;
  h.clock.advance(8 * HOUR);
  await h.board.tick();
  expect(h.runsMade).toHaveLength(0);
  expect(await runsOf(h, s.id)).toEqual([]);
});

test("a once schedule switches off after it fires", async () => {
  const h = makeBoard();
  const s = await addSchedule(h, { kind: "once", date: "2026-10-25", at: "09:00" });
  h.clock.advance(9 * HOUR);
  await h.board.tick();
  const after = await h.board.get(s.id);
  expect(after).toMatchObject({ enabled: false, disabledReason: "done" });
  expect(after?.nextRunAt).toBeUndefined();
  expect(h.runsMade).toHaveLength(1);
});

test("bot gone: disabled, a failed row, no notice", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  h.store.botMap.delete("editor");
  h.clock.advance(8 * HOUR);
  await h.board.tick();
  expect(await h.board.get(s.id)).toMatchObject({ enabled: false, disabledReason: "bot_gone" });
  expect((await runsOf(h, s.id))[0]).toMatchObject({ status: "failed", error: "The bot is gone." });
  expect(h.runsMade).toHaveLength(0);
  expect(h.tells).toEqual([]);
  expect(h.surface.finished).toEqual([]);
  expect(h.log.of("schedule.failed")[0]?.fields).toMatchObject({ reason: "bot_gone" });
});

test("group gone: disabled, a failed row, one notice in the bot's direct chat", async () => {
  const h = makeBoard();
  const s = await addSchedule(h, undefined, { conversationId: "gc" });
  h.store.convMap.delete("gc");
  h.clock.advance(8 * HOUR);
  await h.board.tick();
  await h.board.tick();
  expect(await h.board.get(s.id)).toMatchObject({ enabled: false, disabledReason: "group_gone" });
  expect((await runsOf(h, s.id))[0]?.status).toBe("failed");
  expect(h.tells).toEqual([
    { conversationId: "dc", text: 'Schedule "Brief" is off: its group is gone.' },
  ]);
  expect(h.runsMade).toHaveLength(0);
});

test("left group: two gone outcomes on one day give two failed rows and one notice", async () => {
  const h = makeBoard();
  const s = await addSchedule(
    h,
    { kind: "interval", every: 1, unit: "hours" },
    { conversationId: "gc" },
  );
  h.outcomes.push({ ok: false, reason: "gone" }, { ok: false, reason: "gone" });
  h.clock.advance(HOUR);
  await h.board.tick();
  h.clock.advance(HOUR);
  await h.board.tick();
  const rows = await runsOf(h, s.id);
  expect(rows.map((r) => [r.status, r.error])).toEqual([
    ["failed", "The bot is not a member of the target group."],
    ["failed", "The bot is not a member of the target group."],
  ]);
  const text = 'Schedule "Brief" failed: The bot is not a member of the target group.';
  expect(h.tells).toEqual([{ conversationId: "gc", text }]);
  expect(h.surface.finished).toEqual([{ conversationId: "gc", botId: "editor", preview: text }]);
});

test("a cap block fails the row with the stop text and adds no second notice", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  h.outcomes.push({ ok: false, reason: "spend" });
  h.clock.advance(8 * HOUR);
  await h.board.tick();
  expect((await runsOf(h, s.id))[0]).toMatchObject({
    status: "failed",
    error: "Stopped: spend limit reached.",
  });
  expect(h.tells).toEqual([]);
  expect(h.log.of("schedule.failed")[0]?.fields).toMatchObject({ reason: "spend" });
});

test("parked: an open run skips three due times on one day with one notice", async () => {
  const h = makeBoard();
  const s = await addSchedule(h, { kind: "interval", every: 1, unit: "hours" });
  h.clock.advance(HOUR);
  await h.board.tick();
  putWake(h, "w1", "waiting_input");
  for (let i = 0; i < 3; i++) {
    h.clock.advance(HOUR);
    await h.board.tick();
  }
  const rows = await runsOf(h, s.id);
  expect(rows.map((r) => r.status)).toEqual(["running", "skipped", "skipped", "skipped"]);
  expect(rows[1]?.error).toBe("The previous run has not finished.");
  expect(h.runsMade).toHaveLength(1);
  const text = 'Schedule "Brief" skipped a run: the previous run has not finished.';
  expect(h.tells).toEqual([{ conversationId: "dc", text }]);
  expect(h.surface.finished).toHaveLength(1);
  expect((await h.board.get(s.id))?.nextRunAt).toBe(T0 + 5 * HOUR);
  expect(h.log.of("schedule.skipped")).toHaveLength(3);
  // The next local day may notify again.
  h.clock.advance(DAY);
  await h.board.tick();
  expect(h.tells).toHaveLength(2);
});

test("fire and each settled row tell onChange; a throwing createRun still lets tick resolve", async () => {
  const h = makeBoard({
    createRun: async () => {
      throw new Error("db down");
    },
  });
  const s = await addSchedule(h);
  h.changes.length = 0;
  h.clock.advance(8 * HOUR);
  await h.board.tick();
  expect((await runsOf(h, s.id))[0]).toMatchObject({ status: "failed", error: "db down" });
  expect(h.changes.length).toBeGreaterThanOrEqual(2);
  expect(h.changes.every((id) => id === s.id)).toBe(true);
});

test("a failed wakeId write after a good createRun is no failed row and no notice", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  const update = h.store.scheduleRuns.update;
  h.store.scheduleRuns.update = async (id, patch) => {
    if (patch.wakeId) throw new Error("disk full");
    return update(id, patch);
  };
  h.clock.advance(8 * HOUR);
  await h.board.tick();
  expect(h.runsMade).toHaveLength(1);
  expect((await runsOf(h, s.id))[0]?.status).toBe("running");
  expect(h.tells).toEqual([]);
  expect(h.log.of("schedule.failed")).toEqual([]);
});
