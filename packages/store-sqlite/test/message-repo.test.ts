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
