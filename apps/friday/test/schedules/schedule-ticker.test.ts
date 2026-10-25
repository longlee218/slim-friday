import { expect, test } from "bun:test";
import type { ScheduleBoard } from "@friday/core";
import { FakeClock } from "../../../../packages/core/test/fakes/fake-clock";
import { SCHEDULE_TICK_MS, startScheduleTicker } from "../../src/schedules/schedule-ticker";

const log = { info() {}, warn() {}, error() {} };

/** A board whose `tick` the test controls: each call is counted and resolves when `release()` is called. */
function fakeBoard(opts: { reject?: boolean } = {}) {
  const gates: (() => void)[] = [];
  const state = { calls: 0, running: 0, maxRunning: 0 };
  const board = {
    tick: () => {
      state.calls++;
      state.running++;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      return new Promise<void>((resolve, reject) => {
        gates.push(() => {
          state.running--;
          if (opts.reject) reject(new Error("boom"));
          else resolve();
        });
      });
    },
  } as unknown as ScheduleBoard;
  /** Finish the oldest open pass and let its follow-up run. */
  const release = async () => {
    gates.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { board, state, release };
}

test("a pass runs at start and again after 15 s", async () => {
  const clock = new FakeClock(0);
  const { board, state, release } = fakeBoard();
  const t = startScheduleTicker(board, clock, log);
  expect(state.calls).toBe(1);
  await release();
  clock.advance(SCHEDULE_TICK_MS - 1);
  expect(state.calls).toBe(1);
  clock.advance(1);
  expect(state.calls).toBe(2);
  t.stop();
});

test("kick during a pass runs exactly one more pass after it", async () => {
  const clock = new FakeClock(0);
  const { board, state, release } = fakeBoard();
  const t = startScheduleTicker(board, clock, log);
  t.kick();
  t.kick();
  clock.advance(0);
  expect(state.calls).toBe(1);
  await release();
  clock.advance(0);
  expect(state.calls).toBe(2);
  expect(state.maxRunning).toBe(1);
  await release();
  clock.advance(0);
  expect(state.calls).toBe(2);
  t.stop();
});

test("kick between passes runs a pass at once", async () => {
  const clock = new FakeClock(0);
  const { board, state, release } = fakeBoard();
  const t = startScheduleTicker(board, clock, log);
  await release();
  t.kick();
  clock.advance(0);
  expect(state.calls).toBe(2);
  t.stop();
});

test("stop prevents further passes, including a pending kick", async () => {
  const clock = new FakeClock(0);
  const { board, state, release } = fakeBoard();
  const t = startScheduleTicker(board, clock, log);
  t.kick();
  t.stop();
  await release();
  clock.advance(10 * SCHEDULE_TICK_MS);
  expect(state.calls).toBe(1);
});

test("a rejected tick does not kill the loop", async () => {
  const clock = new FakeClock(0);
  const errors: unknown[] = [];
  const { board, state, release } = fakeBoard({ reject: true });
  const t = startScheduleTicker(board, clock, { ...log, error: (o) => void errors.push(o) });
  await release();
  clock.advance(SCHEDULE_TICK_MS);
  expect(state.calls).toBe(2);
  expect(errors).toHaveLength(1);
  t.stop();
});

test("a tick that throws synchronously does not kill the loop", async () => {
  const clock = new FakeClock(0);
  let calls = 0;
  const board = {
    tick: () => {
      calls++;
      throw new Error("sync");
    },
  } as unknown as ScheduleBoard;
  const t = startScheduleTicker(board, clock, log);
  await new Promise((r) => setTimeout(r, 0));
  clock.advance(SCHEDULE_TICK_MS);
  expect(calls).toBe(2);
  t.stop();
});
