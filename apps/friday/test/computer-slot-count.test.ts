import { expect, test } from "bun:test";
import type { ComputerProvider } from "@friday/core";
import { slotCount } from "../src/computer-slot-count";

/** A log that keeps its messages. */
function memLog() {
  const msgs: string[] = [];
  return {
    msgs,
    info: (_o: object, m: string) => void msgs.push(m),
    warn: (_o: object, m: string) => void msgs.push(m),
  };
}

test("a failed capacity count is retried on a later call after 30 s, not before; recovery logs once", async () => {
  let now = 0;
  let calls = 0;
  const log = memLog();
  const provider = {
    capacity: async () => {
      calls++;
      if (calls === 1) throw new Error("docker is not running");
      return { cpus: 8, memoryMb: 16_384 };
    },
  } as unknown as ComputerProvider;
  const c = slotCount({
    provider,
    settings: { provider: { id: "fake" } },
    problem: "",
    clock: { now: () => now, setTimer: () => () => {} },
    log,
  });
  await c.refresh();
  expect(c.slots()).toBe(0);
  expect(c.text()).toContain("docker is not running");
  now = 29_000;
  await c.refresh();
  await c.refresh();
  expect(calls).toBe(1);
  now = 31_000;
  await Promise.all([c.refresh(), c.refresh()]);
  expect(calls).toBe(2);
  expect(c.slots()).toBeGreaterThan(0);
  now = 100_000;
  await c.refresh();
  expect(calls).toBe(2);
  expect(log.msgs.filter((m) => m === "computer.slots")).toHaveLength(1);
  expect(log.msgs.filter((m) => m === "computer.problem")).toHaveLength(1);
});

test("refresh waits for the first count instead of reporting 0 slots", async () => {
  let done: (c: { cpus: number; memoryMb: number }) => void = () => {};
  const provider = {
    capacity: () => new Promise((r) => (done = r)),
  } as unknown as ComputerProvider;
  const c = slotCount({
    provider,
    settings: { provider: { id: "fake" }, slots: 1 },
    problem: "",
    clock: { now: () => 0, setTimer: () => () => {} },
    log: memLog(),
  });
  expect(c.slots()).toBe(0);
  const waiting = c.refresh();
  done({ cpus: 8, memoryMb: 16_384 });
  await waiting;
  expect(c.slots()).toBe(1);
});

test("no provider: refresh settles at once with the problem as the text", async () => {
  const c = slotCount({
    problem: "no computer provider",
    clock: { now: () => 0, setTimer: () => () => {} },
    log: memLog(),
  });
  await c.refresh();
  expect(c.slots()).toBe(0);
  expect(c.text()).toBe("no computer provider");
});
