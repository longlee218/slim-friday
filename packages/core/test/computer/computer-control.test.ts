import { expect, test } from "bun:test";
import {
  type BotId,
  ComputerBusyError,
  ComputerOwnerControlError,
  controlState,
  giveBack,
  OWNER_HOLDER,
  renewControl,
  takeControl,
  withInputLease,
} from "../../src";
import { FakeClock } from "../fakes/fake-clock";
import { fakeComputerHolds } from "../fakes/fake-computer-holds";

const bot = (s: string) => s as BotId;

function setup() {
  const clock = new FakeClock(1000);
  const holds = fakeComputerHolds();
  const sleep = async (ms: number) => clock.advance(ms);
  return { d: { holds, clock, sleep }, clock, holds };
}

const run = (d: ReturnType<typeof setup>["d"], fn = async () => "ok") =>
  withInputLease(d, { computer: "home", botId: bot("a"), holder: "run-a", waitMs: 60_000 }, fn);

test("takeControl waits for a bot batch, then wins", async () => {
  const { d, clock } = setup();
  const d2 = { ...d, sleep: () => new Promise<void>((r) => setTimeout(r, 1)) };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const batch = run(d2, async () => {
    await gate;
    return "ok";
  });
  await new Promise((r) => setTimeout(r, 5));
  const taking = takeControl(d2, "home");
  await new Promise((r) => setTimeout(r, 10));
  release();
  await batch;
  const hold = await taking;
  expect(hold.holder).toBe(OWNER_HOLDER);
  expect(hold.expiresAt).toBeGreaterThan(clock.now());
});

test("takeControl throws ComputerBusyError when the bot stays busy past 15 s", async () => {
  const { d, holds, clock } = setup();
  await holds.acquire({
    kind: "input",
    computer: "home",
    botId: bot("a"),
    holder: "run-a",
    ttlMs: 120_000,
    now: clock.now(),
  });
  await expect(takeControl(d, "home")).rejects.toBeInstanceOf(ComputerBusyError);
});

test("a second takeControl returns the same hold", async () => {
  const { d } = setup();
  const a = await takeControl(d, "home");
  const b = await takeControl(d, "home");
  expect(b.fence).toBe(a.fence);
  expect(b.holder).toBe(OWNER_HOLDER);
});

test("a bot lease while the owner controls throws at once", async () => {
  const { d, clock } = setup();
  await takeControl(d, "home");
  const t0 = clock.now();
  const err = await run(d).catch((e) => e);
  expect(err).toBeInstanceOf(ComputerOwnerControlError);
  expect(err).toBeInstanceOf(ComputerBusyError);
  expect(err.message).toBe('the owner is controlling computer "home"');
  expect(clock.now()).toBe(t0);
});

test("no renew: the bot acquires after 31 s", async () => {
  const { d, clock } = setup();
  await takeControl(d, "home");
  clock.advance(31_000);
  expect(await run(d)).toBe("ok");
});

test("renewControl keeps the hold; giveBack frees it at once; the next bot fence is higher", async () => {
  const { d, clock, holds } = setup();
  const hold = await takeControl(d, "home");
  clock.advance(20_000);
  expect(await renewControl(d, hold)).toBe(true);
  clock.advance(20_000);
  expect((await controlState(d, "home")).holder).toBe("owner");
  await giveBack(d, hold);
  expect(await controlState(d, "home")).toEqual({ holder: "none" });
  expect(await renewControl(d, hold)).toBe(false);
  const seen: number[] = [];
  await run(d, async () => {
    seen.push((await holds.live(clock.now()))[0]?.fence ?? 0);
    return "ok";
  });
  expect(seen[0]).toBeGreaterThan(hold.fence);
});

test("controlState reports the bot holder", async () => {
  const { d } = setup();
  let state: unknown;
  await run(d, async () => {
    state = await controlState(d, "home");
    return "ok";
  });
  expect(state).toMatchObject({ holder: "bot", botId: "a" });
});
