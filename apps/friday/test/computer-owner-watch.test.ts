import { expect, test } from "bun:test";
import { renewControl, takeControl } from "@friday/core";
import { FakeClock } from "../../../packages/core/test/fakes/fake-clock";
import { fakeComputerHolds } from "../../../packages/core/test/fakes/fake-computer-holds";
import { watchOwnerControl } from "../src/computer-owner-watch";

function setup() {
  const clock = new FakeClock(1000);
  const holds = fakeComputerHolds();
  const ended: string[] = [];
  let tick: () => void = () => {};
  let stopped = false;
  const stop = watchOwnerControl(
    { holds, clock, onEnded: async (c) => void ended.push(c) },
    (_ms, fn) => {
      tick = fn;
      return () => {
        stopped = true;
      };
    },
  );
  const flush = async () => {
    tick();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    clock,
    holds,
    ended,
    flush,
    stop,
    d: { holds, clock, sleep: async () => {} },
    isStopped: () => stopped,
  };
}

test("an owner hold that lapses without renew counts as expiry", async () => {
  const w = setup();
  await takeControl(w.d, "home");
  await w.flush();
  expect(w.ended).toEqual([]);
  w.clock.advance(31_000);
  await w.flush();
  expect(w.ended).toEqual(["home"]);
  await w.flush();
  expect(w.ended).toEqual(["home"]);
});

test("a renewed hold does not expire, a given-back one ends once", async () => {
  const w = setup();
  const hold = await takeControl(w.d, "home");
  await w.flush();
  w.clock.advance(20_000);
  await renewControl(w.d, hold);
  w.clock.advance(20_000);
  await w.flush();
  expect(w.ended).toEqual([]);
  await w.holds.release({ key: hold.key, holder: hold.holder, fence: hold.fence });
  await w.flush();
  expect(w.ended).toEqual(["home"]);
});

test("a hold never seen live does not end; stop cancels the timer", async () => {
  const w = setup();
  await w.flush();
  expect(w.ended).toEqual([]);
  w.stop();
  expect(w.isStopped()).toBe(true);
});
