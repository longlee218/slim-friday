import { expect, test } from "bun:test";
import { startTiming } from "../../src/runs/run-timing";
import { FakeLog } from "../fakes/fake-log";

/** A clock the test steps by hand. */
const stepClock = (t = 100) => ({
  now: () => t,
  step: (ms: number) => {
    t += ms;
  },
});

test("a run logs its timings once at finish, ms from the claim", () => {
  const clock = stepClock();
  const log = new FakeLog();
  const timing = startTiming(clock, log, "w1", "ann");
  clock.step(5);
  timing.mark("openMs");
  clock.step(7);
  timing.mark("turnBuildMs");
  clock.step(30);
  timing.mark("firstEventMs");
  timing.mark("firstTextMs");
  clock.step(100);
  timing.mark("firstTextMs"); // only the first counts
  timing.finish();
  timing.finish();
  expect(log.of("run.timing")).toHaveLength(1);
  expect(log.of("run.timing")[0]?.level).toBe("info");
  expect(log.of("run.timing")[0]?.fields).toEqual({
    event: "run.timing",
    wakeId: "w1",
    scope: "ann",
    openMs: 5,
    turnBuildMs: 12,
    firstEventMs: 42,
    firstTextMs: 42,
  });
});

test("a run that never reaches text omits the missing values", () => {
  const clock = stepClock();
  const log = new FakeLog();
  const timing = startTiming(clock, log, "w2", "ann");
  clock.step(3);
  timing.mark("openMs");
  timing.finish();
  expect(log.of("run.timing")[0]?.fields).toEqual({
    event: "run.timing",
    wakeId: "w2",
    scope: "ann",
    openMs: 3,
  });
});
