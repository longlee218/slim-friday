import { expect, test } from "bun:test";
import {
  acquireSlot,
  type BotId,
  ComputerBusyError,
  releaseSlot,
  renewSlot,
  withInputLease,
} from "../../src";
import { FakeClock } from "../fakes/fake-clock";
import { fakeComputerHolds } from "../fakes/fake-computer-holds";

const bot = (s: string) => s as BotId;

/** Deps whose `sleep` moves the fake clock instead of waiting. */
function setup() {
  const clock = new FakeClock(1000);
  const holds = fakeComputerHolds();
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock.advance(ms);
  };
  return { d: { holds, clock, sleep }, clock, holds, sleeps };
}

test("queued holder gets the input lease after the first releases", async () => {
  const { d, clock } = setup();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // Real-time yields stand in for the poll wait: this sleep never moves the clock.
  const d2 = { ...d, sleep: () => new Promise<void>((r) => setTimeout(r, 1)) };
  const a = withInputLease(d2, { computer: "home", botId: bot("a"), holder: "run-a" }, async () => {
    order.push("a");
    await gate;
  });
  await new Promise((r) => setTimeout(r, 5));
  const b = withInputLease(d2, { computer: "home", botId: bot("b"), holder: "run-b" }, async () => {
    order.push("b");
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(order).toEqual(["a"]);
  release();
  await Promise.all([a, b]);
  expect(order).toEqual(["a", "b"]);
  expect(await d.holds.live(clock.now())).toEqual([]);
});

test("timeout throws ComputerBusyError naming the computer and wait", async () => {
  const { d } = setup();
  await d.holds.acquire({
    kind: "input",
    computer: "home",
    botId: bot("a"),
    holder: "run-a",
    ttlMs: 1_000_000,
    now: d.clock.now(),
  });
  const p = withInputLease(
    d,
    { computer: "home", botId: bot("b"), holder: "run-b", waitMs: 60_000 },
    async () => 1,
  );
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(ComputerBusyError);
  expect(err.message).toBe('computer "home" is busy (input); waited 60 s');
});

test("stale holder is refused after expiry", async () => {
  const { d, clock } = setup();
  let thrown: unknown;
  await withInputLease(
    d,
    { computer: "home", botId: bot("a"), holder: "run-a", ttlMs: 1000 },
    async (check) => {
      clock.advance(5000);
      const other = await d.holds.acquire({
        kind: "input",
        computer: "home",
        botId: bot("b"),
        holder: "run-b",
        ttlMs: 1000,
        now: clock.now(),
      });
      expect(other).toBeDefined();
      try {
        await check();
      } catch (e) {
        thrown = e;
      }
    },
  );
  expect(thrown).toBeInstanceOf(ComputerBusyError);
  expect((thrown as Error).message).toBe("lease lost");
});

test("check keeps the lease alive past the original ttl", async () => {
  const { d, clock, holds } = setup();
  await withInputLease(
    d,
    { computer: "home", botId: bot("a"), holder: "run-a", ttlMs: 1000 },
    async (check) => {
      for (let i = 0; i < 4; i++) {
        clock.advance(800);
        await check();
      }
      expect((await holds.live(clock.now())).map((h) => h.key)).toEqual(["input:home"]);
    },
  );
});

test("fn throwing still releases the lease", async () => {
  const { d, holds, clock } = setup();
  await expect(
    withInputLease(d, { computer: "home", botId: bot("a"), holder: "run-a" }, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(await holds.live(clock.now())).toEqual([]);
});

test("slotLimit 0 throws at once without polling", async () => {
  const { d, sleeps } = setup();
  const p = acquireSlot(d, {
    computer: "home",
    botId: bot("a"),
    holder: "run-a",
    slotLimit: 0,
    slotsText: "0 slots, limited by memory (1024 MB)",
  });
  await expect(p).rejects.toThrow(
    "no computer slot on this machine: 0 slots, limited by memory (1024 MB)",
  );
  expect(sleeps).toEqual([]);
});

test("slot waits for a free slot, renews and releases", async () => {
  const { d, clock, holds } = setup();
  const first = await acquireSlot(d, {
    computer: "home",
    botId: bot("a"),
    holder: "run-a",
    slotLimit: 1,
  });
  expect(first.key).toBe("slot:a");
  const d2 = { ...d, sleep: () => new Promise<void>((r) => setTimeout(r, 1)) };
  const waiter = acquireSlot(d2, {
    computer: "home",
    botId: bot("b"),
    holder: "run-b",
    slotLimit: 1,
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(await renewSlot(d, first)).toBe(true);
  await releaseSlot(d, first);
  const second = await waiter;
  expect(second.key).toBe("slot:b");
  expect((await holds.live(clock.now())).length).toBe(1);
});

test("slot timeout names the slot wait", async () => {
  const { d } = setup();
  await acquireSlot(d, { computer: "home", botId: bot("a"), holder: "run-a", slotLimit: 1 });
  const err = await acquireSlot(d, {
    computer: "home",
    botId: bot("b"),
    holder: "run-b",
    slotLimit: 1,
    waitMs: 1000,
  }).catch((e) => e);
  expect(err.message).toBe('computer "home" is busy (slot); waited 1 s');
});
