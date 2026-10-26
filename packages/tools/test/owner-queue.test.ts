import { expect, test } from "bun:test";
import type { MemoryOwner } from "@friday/core";
import { createOwnerQueue } from "../src/memory/owner-queue";

const dev: MemoryOwner = { kind: "bot", botId: "dev" };
const ops: MemoryOwner = { kind: "bot", botId: "ops" };

/** A promise settled from outside. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("queue serializes same owner", async () => {
  const queue = createOwnerQueue();
  const gate = deferred();
  const log: string[] = [];
  const first = queue(dev, async () => {
    log.push("first start");
    await gate.promise;
    log.push("first end");
  });
  const second = queue(dev, async () => {
    log.push("second start");
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["first start"]);
  gate.resolve();
  await Promise.all([first, second]);
  expect(log).toEqual(["first start", "first end", "second start"]);
});

test("different owners run in parallel", async () => {
  const queue = createOwnerQueue();
  const gate = deferred();
  const log: string[] = [];
  const a = queue(dev, async () => {
    log.push("dev start");
    await gate.promise;
  });
  const b = queue(ops, async () => {
    log.push("ops start");
  });
  await b;
  expect(log).toEqual(["dev start", "ops start"]);
  gate.resolve();
  await a;
});

test("a failure does not block the next call", async () => {
  const queue = createOwnerQueue();
  const failed = queue(dev, async () => {
    throw new Error("boom");
  });
  const next = queue(dev, async () => "ok");
  await expect(failed).rejects.toThrow("boom");
  expect(await next).toBe("ok");
});

test("a bot and a group with the same id do not share a chain", async () => {
  const queue = createOwnerQueue();
  const gate = deferred();
  const a = queue({ kind: "bot", botId: "x" }, () => gate.promise);
  const b = await queue({ kind: "group", groupId: "x" }, async () => "done");
  expect(b).toBe("done");
  gate.resolve();
  await a;
});
