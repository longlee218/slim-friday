import { expect, test } from "bun:test";
import { addSchedule, HOUR, MIN, makeBoard, putWake, runsOf, T0 } from "./schedule-harness";

const AT_0730 = T0 + 7 * HOUR + 30 * MIN;

test("runNow: refused while a run is open; else a manual run that does not move the next run", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  h.clock.advance(HOUR);
  const r = await h.board.runNow(s.id, "n1");
  expect(r).toEqual({ ok: true, wakeId: "w1" });
  expect(h.runsMade[0]?.dedupeKey).toBe(`sched:${s.id}:manual:n1`);
  expect((await h.board.get(s.id))?.nextRunAt).toBe(AT_0730);
  expect((await runsOf(h, s.id))[0]).toMatchObject({ manual: true, dueAt: T0 + HOUR, late: false });
  putWake(h, "w1", "running");
  expect(await h.board.runNow(s.id, "n2")).toEqual({
    ok: false,
    code: "conflict",
    error: "Still running.",
  });
  expect(await h.board.runNow("nope", "n3")).toMatchObject({ code: "not_found" });
});
