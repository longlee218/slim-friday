import { expect, test } from "bun:test";
import { type BotId, takeControl } from "@friday/core";
import { FakeClock } from "../../../core/test/fakes/fake-clock";
import { fakeComputerHolds } from "../../../core/test/fakes/fake-computer-holds";
import type { ComputerContext } from "../../src/computer/computer-context";
import { createComputerSession } from "../../src/computer/computer-session";

function setup(blocked: [BotId, string][]) {
  const clock = new FakeClock(1000);
  const holds = fakeComputerHolds();
  const ctx: ComputerContext = {
    botId: "ann" as BotId,
    holder: "h-ann",
    computer: { name: "box", cpus: 1, memoryMb: 512 },
    provider: { ensure: async () => {} } as never,
    holds,
    clock,
    sleep: async (ms) => clock.advance(ms),
    slotLimit: () => 2,
    slotsText: () => "0 of 2 slots",
    browser: { ensure: async () => {}, close: async () => {} } as never,
    onOwnerBlocked: (botId, computer) => void blocked.push([botId, computer]),
  };
  return { clock, holds, session: createComputerSession(ctx) };
}

test("a leased call during owner control returns the readable error at once and records the bot", async () => {
  const blocked: [BotId, string][] = [];
  const { clock, holds, session } = setup(blocked);
  await takeControl({ holds, clock, sleep: async () => {} }, "box");
  const t0 = clock.now();
  const r = await session.runLeased(async () => ({ content: [] }));
  expect(r.isError).toBe(true);
  expect(JSON.stringify(r)).toContain(
    "the owner is controlling this computer; end this turn and say you will continue when they give it back",
  );
  expect(clock.now() - t0).toBeLessThan(1000);
  expect(blocked).toEqual([["ann", "box"]]);
});

test("no owner control records nothing", async () => {
  const blocked: [BotId, string][] = [];
  const { session } = setup(blocked);
  const r = await session.runLeased(async () => ({ content: [] }));
  expect(r.isError).toBeUndefined();
  expect(blocked).toEqual([]);
});
