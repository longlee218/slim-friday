import { expect, test } from "bun:test";
import { z } from "zod";
import { FakeClock } from "../../../core/test/fakes/fake-clock";
import { fakeComputerHolds } from "../../../core/test/fakes/fake-computer-holds";
import type { ComputerContext } from "../../src/computer/computer-context";
import { createComputerSession } from "../../src/computer/computer-session";
import { HEARTBEAT_MS } from "../../src/computer/slot-heartbeat";
import { createComputerActTool } from "../../src/computer/tools/ComputerActTool/computer-act-tool";
import { createComputerShellTool } from "../../src/computer/tools/ComputerShellTool/computer-shell-tool";

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const call = (t: { handler: (a: never, e: unknown) => Promise<unknown> }, args: object) =>
  t.handler(args as never, {}) as Promise<Result>;
const textOf = (r: Result) => r.content.map((c) => c.text ?? "").join("\n");
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** One bot session over a fake clock; the heartbeat runs on the clock's timers. */
function world(over: Partial<ComputerContext> = {}) {
  const clock = new FakeClock(1000);
  const base = fakeComputerHolds();
  let renews = 0;
  const holds = {
    ...base,
    renew: (a: Parameters<typeof base.renew>[0]) => {
      renews++;
      return base.renew(a);
    },
  };
  const every = (ms: number, fn: () => void) => {
    let stop = () => {};
    const arm = () => {
      stop = clock.setTimer(ms, () => {
        arm();
        fn();
      });
    };
    arm();
    return () => stop();
  };
  const ctx: ComputerContext = {
    botId: "ann",
    holder: "w1",
    computer: { name: "box", cpus: 1, memoryMb: 512 },
    provider: {
      ensure: async () => {},
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      act: async () => {},
    } as never,
    holds,
    clock,
    sleep: async () => clock.advance(250),
    slotLimit: () => 1,
    slotsText: () => "1 slot",
    browser: { ensure: async () => {} } as never,
    every,
    ...over,
  };
  const session = createComputerSession(ctx);
  return { clock, holds, session, renews: () => renews };
}

/** Advance the clock one beat at a time so each renew settles. */
async function pass(clock: FakeClock, ms: number) {
  for (let t = 0; t < ms; t += HEARTBEAT_MS) {
    clock.advance(Math.min(HEARTBEAT_MS, ms - t));
    await flush();
  }
}

test("the heartbeat renews a held slot every 40 s", async () => {
  const w = world();
  expect((await call(createComputerShellTool(w.session), { command: ["ls"] })).isError).toBe(
    undefined,
  );
  await pass(w.clock, HEARTBEAT_MS);
  const [row] = await w.holds.live(w.clock.now());
  expect(row?.expiresAt).toBe(w.clock.now() + 120_000);
  expect(w.renews()).toBe(1);
});

test("the heartbeat stops after a renew returns false (the run-end release)", async () => {
  const w = world();
  await call(createComputerShellTool(w.session), { command: ["ls"] });
  const [row] = await w.holds.live(w.clock.now());
  if (!row) throw new Error("no slot");
  await w.holds.release(row);
  await pass(w.clock, HEARTBEAT_MS);
  expect(w.renews()).toBe(1);
  await pass(w.clock, 5 * HEARTBEAT_MS);
  expect(w.renews()).toBe(1);
});

test("a long pause between two calls keeps the slot: another bot is refused meanwhile", async () => {
  const w = world();
  const tool = createComputerShellTool(w.session);
  await call(tool, { command: ["ls"] });
  await pass(w.clock, 300_000);
  const other = await w.holds.acquire({
    kind: "slot",
    computer: "box",
    botId: "bob",
    holder: "w2",
    ttlMs: 120_000,
    now: w.clock.now(),
    slotLimit: 1,
  });
  expect(other).toBeUndefined();
  expect((await call(tool, { command: ["ls"] })).isError).toBeUndefined();
});

test("after 10 min without a tool call the heartbeat stops (a parked session gives its slot back)", async () => {
  const w = world();
  await call(createComputerShellTool(w.session), { command: ["ls"] });
  await pass(w.clock, 640_000);
  const n = w.renews();
  await pass(w.clock, 200_000);
  expect(w.renews()).toBe(n);
  expect(await w.holds.live(w.clock.now())).toEqual([]);
});

test("an idle stop closes the browser and releases the slot; the next call re-acquires", async () => {
  let closed = 0;
  let ensured = 0;
  const w = world({
    browser: {
      ensure: async () => {
        ensured++;
      },
      close: async () => {
        closed++;
      },
    } as never,
  });
  const tool = createComputerShellTool(w.session);
  await call(tool, { command: ["ls"] });
  await pass(w.clock, 640_000);
  expect(closed).toBe(1);
  expect(await w.holds.live(w.clock.now())).toEqual([]);
  expect((await call(tool, { command: ["ls"] })).isError).toBeUndefined();
  expect(ensured).toBe(2);
  expect(await w.holds.live(w.clock.now())).toHaveLength(1);
});

test("a call that lands while the idle stop is closing the browser keeps the slot it then takes", async () => {
  let finishClose = () => {};
  const w = world({
    browser: {
      ensure: async () => {},
      close: () =>
        new Promise<void>((r) => {
          finishClose = r;
        }),
    } as never,
  });
  const tool = createComputerShellTool(w.session);
  await call(tool, { command: ["ls"] });
  await pass(w.clock, 640_000);
  // The idle stop is now waiting on browser.close(); a new call arrives in that window.
  const late = call(tool, { command: ["ls"] });
  await flush();
  finishClose();
  expect((await late).isError).toBeUndefined();
  await flush();
  expect(await w.holds.live(w.clock.now())).toHaveLength(1);
});

test("the first call waits for the slot count instead of being refused", async () => {
  let limit = 0;
  let done: () => void = () => {};
  const ready = new Promise<void>((r) => (done = r));
  const w = world({ slotLimit: () => limit, slotsReady: () => ready });
  const pending = call(createComputerShellTool(w.session), { command: ["ls"] });
  await flush();
  limit = 1;
  done();
  expect((await pending).isError).toBeUndefined();
});

test("ComputerAct refuses a wait over 10 000 ms with a readable message", async () => {
  const w = world();
  const tool = createComputerActTool(w.session);
  const r = await call(tool, { actions: [{ kind: "wait", ms: 10_001 }] });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toBe("wait ms must be at most 10000.");
  const schema = z.object(tool.inputSchema);
  const parsed = schema.safeParse({ actions: [{ kind: "wait", ms: 10_001 }] });
  expect(parsed.success).toBe(false);
  expect(parsed.error?.issues[0]?.message).toBe("wait ms must be at most 10000.");
  expect(schema.safeParse({ actions: [{ kind: "wait", ms: 10_000 }] }).success).toBe(true);
});
