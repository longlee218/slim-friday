import { expect, test } from "bun:test";
import type { WakeRow } from "@friday/core";
import { openEngineStore } from "../src/engine-store";

/** A queued wake from the user; tests override what they need. */
const wake = (id: string, over: Partial<WakeRow> = {}): WakeRow => ({
  id,
  chainId: "ch1",
  conversationId: "c1",
  targetBot: "b1",
  sender: { kind: "user" },
  intent: "request",
  hop: 0,
  text: `text ${id}`,
  status: "queued",
  attempts: 1,
  createdAt: 1,
  scopeKey: "s",
  priority: "interactive",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  ...over,
});

test("insert then get returns the row incl. sender, parent and attachments", async () => {
  const s = openEngineStore(":memory:");
  const attachments = [{ name: "1-a.png", mimeType: "image/png", path: "/x/a.png", size: 3 }];
  await s.wakes.insert(
    wake("w1", {
      sender: { kind: "bot", botId: "b2" },
      parentWakeId: "w0",
      handoff: true,
      attachments,
    }),
  );
  expect(await s.wakes.get("w1")).toEqual(
    wake("w1", {
      sender: { kind: "bot", botId: "b2" },
      parentWakeId: "w0",
      handoff: true,
      attachments,
    }),
  );
  expect(await s.wakes.get("nope")).toBeUndefined();
});

test("update sets status and timestamps", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("w1"));
  await s.wakes.update("w1", { status: "running", startedAt: 5, attempts: 2 });
  await s.wakes.update("w1", {
    status: "blocked",
    blockReason: "hops",
    endedAt: 9,
    firstTextAt: 7,
  });
  expect(await s.wakes.get("w1")).toMatchObject({
    status: "blocked",
    blockReason: "hops",
    startedAt: 5,
    firstTextAt: 7,
    endedAt: 9,
    attempts: 2,
  });
});

test("open returns only queued and running, oldest first", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("w3", { createdAt: 3, status: "running" }));
  await s.wakes.insert(wake("w1", { createdAt: 1 }));
  await s.wakes.insert(wake("w2", { createdAt: 2, status: "done" }));
  expect((await s.wakes.open()).map((w) => w.id)).toEqual(["w1", "w3"]);
});

test("botSentSince returns only bot-sent rows of the conversation after the time", async () => {
  const s = openEngineStore(":memory:");
  const bot = { kind: "bot", botId: "b2" } as const;
  await s.wakes.insert(wake("old", { sender: bot, createdAt: 10 }));
  await s.wakes.insert(wake("new", { sender: bot, createdAt: 100 }));
  await s.wakes.insert(wake("user", { createdAt: 100 }));
  await s.wakes.insert(wake("other", { sender: bot, createdAt: 100, conversationId: "c2" }));
  expect((await s.wakes.botSentSince("c1", 50)).map((w) => w.id)).toEqual(["new"]);
});

test("deleteFinishedBefore removes finished rows only and returns the count", async () => {
  const s = openEngineStore(":memory:");
  for (const [id, status] of [
    ["a", "done"],
    ["b", "blocked"],
    ["c", "expired"],
    ["d", "dropped"],
    ["e", "interrupted"],
    ["f", "queued"],
    ["g", "running"],
  ] as const)
    await s.wakes.insert(wake(id, { status, createdAt: 1, endedAt: 2 }));
  await s.wakes.insert(wake("h", { status: "done", createdAt: 1, endedAt: 500 }));
  expect(await s.wakes.deleteFinishedBefore(100)).toBe(5);
  expect((await s.wakes.open()).map((w) => w.id).sort()).toEqual(["f", "g"]);
  expect(await s.wakes.get("h")).toBeDefined();
});

test("deleteFinishedBefore keeps leased and waiting_input rows", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("l", { status: "leased", createdAt: 1 }));
  await s.wakes.insert(wake("w", { status: "waiting_input", createdAt: 1 }));
  expect(await s.wakes.deleteFinishedBefore(100)).toBe(0);
  expect(await s.wakes.get("l")).toBeDefined();
  expect(await s.wakes.get("w")).toBeDefined();
});

test("list filters by status and since, newest first, honours limit", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("w1", { createdAt: 10 }));
  await s.wakes.insert(wake("w2", { createdAt: 20, status: "done" }));
  await s.wakes.insert(wake("w3", { createdAt: 30 }));
  await s.wakes.insert(wake("w4", { createdAt: 40, status: "done" }));
  const ids = async (f: Parameters<typeof s.wakes.list>[0]) =>
    (await s.wakes.list(f)).map((w) => w.id);
  expect(await ids({ since: 0, limit: 10 })).toEqual(["w4", "w3", "w2", "w1"]);
  expect(await ids({ since: 20, limit: 10 })).toEqual(["w4", "w3", "w2"]);
  expect(await ids({ since: 0, limit: 10, status: "done" })).toEqual(["w4", "w2"]);
  expect(await ids({ since: 0, limit: 2 })).toEqual(["w4", "w3"]);
});
