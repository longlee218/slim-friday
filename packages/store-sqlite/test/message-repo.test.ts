import { expect, test } from "bun:test";
import { openEngineStore } from "../src/engine-store";

const fresh = () => openEngineStore(":memory:");
const user = { kind: "user" } as const;

test("append returns increasing ids and keeps kind, replyTo, files, run, relay", async () => {
  const s = fresh();
  const a = await s.messages.append({ conversationId: "bot:a", author: user, text: "hi", at: 1 });
  const b = await s.messages.append({
    conversationId: "bot:a",
    author: { kind: "bot", botId: "a" },
    text: "",
    at: 2,
    kind: "file",
    replyTo: a,
    files: [{ fileId: "f1", name: "x.png", mimeType: "image/png", size: 3, width: 1, height: 1 }],
    run: [{ id: "t", kind: "tool", label: "Read", state: "done", startedAt: 1, endedAt: 2 }],
    relay: { fromBotId: "a", toBotId: "b", intent: "request" },
  });
  expect(b).toBeGreaterThan(a);
  expect(await s.messages.get(b)).toMatchObject({
    id: b,
    kind: "file",
    replyTo: a,
    files: [{ fileId: "f1" }],
    run: [{ id: "t" }],
    relay: { toBotId: "b" },
  });
  expect((await s.messages.get(a))?.kind).toBe("text");
  expect(await s.messages.get(999)).toBeUndefined();
});

test("page is newest first and pages with before", async () => {
  const s = fresh();
  for (let i = 1; i <= 5; i++)
    await s.messages.append({ conversationId: "bot:a", author: user, text: `m${i}`, at: i });
  await s.messages.append({ conversationId: "bot:b", author: user, text: "other", at: 9 });
  const ids = (r: { id: number }[]) => r.map((m) => m.id);
  expect(ids(await s.messages.page("bot:a", { limit: 2 }))).toEqual([5, 4]);
  expect(ids(await s.messages.page("bot:a", { before: 4, limit: 2 }))).toEqual([3, 2]);
});

test("recent and after still return the plain fields", async () => {
  const s = fresh();
  await s.messages.append({ conversationId: "bot:a", author: user, text: "hi", at: 1 });
  expect((await s.messages.recent("bot:a", 5))[0]?.text).toBe("hi");
  expect((await s.messages.after(0, 5))[0]?.id).toBe(1);
});

test("page with before 0 is a filter (nothing is older), not 'no filter'", async () => {
  const s = fresh();
  await s.messages.append({ conversationId: "bot:a", author: user, text: "hi", at: 1 });
  expect(await s.messages.page("bot:a", { before: 0, limit: 10 })).toEqual([]);
  expect(await s.messages.page("bot:a", { limit: 10 })).toHaveLength(1);
});

test("wakeId round-trips and countInterim counts only progress rows of that wake", async () => {
  const s = fresh();
  const base = { conversationId: "bot:a", author: { kind: "bot", botId: "a" } as const, at: 1 };
  await s.messages.append({ ...base, text: "p1", kind: "progress", wakeId: "w1" });
  await s.messages.append({ ...base, text: "p2", kind: "progress", wakeId: "w1" });
  await s.messages.append({ ...base, text: "p3", kind: "progress", wakeId: "w2" });
  const final = await s.messages.append({ ...base, text: "done", wakeId: "w1" });
  await s.messages.append({ ...base, text: "no wake" });
  expect(await s.messages.countInterim("w1")).toBe(2);
  expect(await s.messages.countInterim("w3")).toBe(0);
  expect((await s.messages.get(final))?.wakeId).toBe("w1");
  expect((await s.messages.get(final + 1))?.wakeId).toBeUndefined();
});

test("lastText is the newest plain text message of a wake; progress, relay and other wakes are skipped", async () => {
  const s = fresh();
  const base = { conversationId: "bot:a", author: { kind: "bot", botId: "a" } as const, at: 1 };
  expect(await s.messages.lastText("w1")).toBeUndefined();
  await s.messages.append({ ...base, text: "first", wakeId: "w1" });
  await s.messages.append({ ...base, text: "second", wakeId: "w1" });
  await s.messages.append({ ...base, text: "note", kind: "progress", wakeId: "w1" });
  await s.messages.append({ ...base, text: "other", wakeId: "w2" });
  await s.messages.append({ ...base, text: "owner", author: { kind: "user" }, wakeId: "w1" });
  expect(await s.messages.lastText("w1")).toBe("second");
});

test("a schedule tag round-trips; a message without one has none", async () => {
  const s = fresh();
  const bot = { kind: "bot", botId: "a" } as const;
  const id = await s.messages.append({
    conversationId: "bot:a",
    author: bot,
    text: "brief",
    at: 1,
    wakeId: "w1",
    scheduleId: "s1",
    scheduleName: "Morning brief",
  });
  const plain = await s.messages.append({ conversationId: "bot:a", author: bot, text: "x", at: 2 });
  expect(await s.messages.get(id)).toMatchObject({
    scheduleId: "s1",
    scheduleName: "Morning brief",
  });
  const other = await s.messages.get(plain);
  expect(other?.scheduleId).toBeUndefined();
  expect(other?.scheduleName).toBeUndefined();
  expect((await s.messages.recent("bot:a", 1))[0]?.scheduleId).toBeUndefined();
});

test("lastIdOf gives the id of a wake's last message, undefined when it has none", async () => {
  const s = fresh();
  const bot = { kind: "bot", botId: "a" } as const;
  await s.messages.append({ conversationId: "bot:a", author: bot, text: "1", at: 1, wakeId: "w1" });
  const last = await s.messages.append({
    conversationId: "bot:a",
    author: bot,
    text: "2",
    at: 2,
    wakeId: "w1",
    kind: "progress",
  });
  await s.messages.append({ conversationId: "bot:a", author: bot, text: "3", at: 3, wakeId: "w2" });
  expect(await s.messages.lastIdOf("w1")).toBe(last);
  expect(await s.messages.lastIdOf("none")).toBeUndefined();
});
