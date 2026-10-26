import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryOwner } from "@friday/core";
import { appendJournal, createOwnerQueue, FileMemory } from "@friday/tools";
import { flushConsolidation } from "../src/flush-consolidation";

const dev: MemoryOwner = { kind: "bot", botId: "dev" };

/** Memory with one journal note of `dev` today. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "flushc-"));
  appendJournal(root, dev, "Idle flush", ["owner ships on fridays"], new Date());
  return { root, memory: new FileMemory(root) };
}

const parts = (memory: FileMemory, ask: Parameters<typeof flushConsolidation>[0]["ask"]) => ({
  memory,
  queue: createOwnerQueue(),
  known: async () => undefined,
  ask,
  now: () => new Date(),
});

test("a consolidation whose ask never answers does not hold stop, and nothing is written after stop", async () => {
  const { root, memory } = setup();
  let answer: ((v: { kind: "fact"; note: string }[]) => void) | undefined;
  const c = flushConsolidation(
    parts(memory, () => new Promise((r) => (answer = r as typeof answer))),
  );
  const pending = c.consolidate(dev);
  await Bun.sleep(0);
  const r = await Promise.race([
    c.stop().then(() => "stopped"),
    Bun.sleep(1000).then(() => "hung"),
  ]);
  expect(r).toBe("stopped");
  answer?.([{ kind: "fact", note: "owner ships on fridays" }]);
  await pending.catch(() => undefined);
  await Bun.sleep(10);
  expect(memory.listBullets(dev)).toEqual([]);
  // No mark file: the journal notes stay for the next run.
  expect(readdirSync(join(root, "bots", "dev"))).toEqual(["journal"]);
});

test("after stop no new consolidation starts", async () => {
  const { memory } = setup();
  let asked = 0;
  const c = flushConsolidation(
    parts(memory, async (_m, notes) => {
      asked++;
      return notes.map((note) => ({ kind: "fact" as const, note }));
    }),
  );
  await c.stop();
  await c.consolidate(dev);
  expect(asked).toBe(0);
});

test("a consolidation before stop promotes the notes", async () => {
  const { memory } = setup();
  const c = flushConsolidation(
    parts(memory, async (_m, notes) => notes.map((note) => ({ kind: "fact" as const, note }))),
  );
  await c.consolidate(dev);
  expect(memory.listBullets(dev).map((b) => b.text)).toEqual(["owner ships on fridays"]);
});
