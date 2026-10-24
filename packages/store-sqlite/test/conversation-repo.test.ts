import { expect, test } from "bun:test";
import { openEngineStore } from "../src/engine-store";

const user = { kind: "user" } as const;

test("list returns every conversation", async () => {
  const s = openEngineStore(":memory:");
  await s.conversations.put({ id: "bot:a", kind: "direct", botId: "a" });
  await s.conversations.put({ id: "group:g", kind: "group", groupId: "g" });
  expect((await s.conversations.list()).map((c) => c.id).sort()).toEqual(["bot:a", "group:g"]);
});

test("deleteLegacy removes chat-app-keyed conversations and their messages only", async () => {
  const s = openEngineStore(":memory:");
  const old = "123456789012345678";
  await s.conversations.put({ id: old, kind: "direct", botId: "a" });
  await s.conversations.put({ id: "bot:a", kind: "direct", botId: "a" });
  await s.messages.append({ conversationId: old, author: user, text: "old", at: 1 });
  await s.messages.append({ conversationId: "bot:a", author: user, text: "new", at: 2 });
  expect(await s.conversations.deleteLegacy()).toBe(1);
  expect(await s.conversations.get(old)).toBeUndefined();
  expect(await s.conversations.get("bot:a")).toBeDefined();
  expect((await s.messages.recent("bot:a", 5)).length).toBe(1);
  expect((await s.messages.after(0, 10)).every((m) => m.conversationId === "bot:a")).toBe(true);
  expect(await s.conversations.deleteLegacy()).toBe(0);
});
