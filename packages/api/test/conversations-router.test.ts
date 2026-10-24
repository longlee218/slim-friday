import { expect, test } from "bun:test";
import { engineHarness } from "./helpers/engine-deps";

const owner = (conversationId: string, text: string, replyTo?: number) => ({
  conversationId,
  author: { kind: "user" as const },
  text,
  at: 1,
  ...(replyTo !== undefined && { replyTo }),
});
const fromBot = (conversationId: string, botId: string, text: string) => ({
  conversationId,
  author: { kind: "bot" as const, botId },
  text,
  at: 2,
});

test("messages of an unknown conversation is NOT_FOUND", async () => {
  const h = engineHarness();
  await expect(
    h.client.conversations.messages({ id: "bot:nope", limit: 10 }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("markRead of an unknown conversation is NOT_FOUND", async () => {
  const h = engineHarness();
  await expect(
    h.client.conversations.markRead({ id: "bot:nope", messageId: 1 }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("list hides a conversation whose bot or group is gone", async () => {
  const h = engineHarness();
  h.addBot("a", "Ann");
  h.store.convMap.set("bot:a", { id: "bot:a", kind: "direct", botId: "a" });
  h.store.convMap.set("bot:gone", { id: "bot:gone", kind: "direct", botId: "gone" });
  h.store.convMap.set("group:gone", { id: "group:gone", kind: "group", groupId: "gone" });
  expect((await h.client.conversations.list()).map((c) => c.id)).toEqual(["bot:a"]);
});

test("list: direct first then groups, each by title, with last message and unread", async () => {
  const h = engineHarness();
  h.addBot("a", "Zed");
  h.addBot("b", "Amy");
  h.addGroup({ id: "g", name: "Aaa team" });
  h.store.convMap.set("group:g", { id: "group:g", kind: "group", groupId: "g" });
  h.store.convMap.set("bot:a", { id: "bot:a", kind: "direct", botId: "a" });
  h.store.convMap.set("bot:b", { id: "bot:b", kind: "direct", botId: "b" });
  await h.store.messages.append(owner("bot:a", "hi"));
  await h.store.messages.append(fromBot("bot:a", "a", "hello"));
  const list = await h.client.conversations.list();
  expect(list.map((c) => c.title)).toEqual(["Amy", "Zed", "Aaa team"]);
  const zed = list.find((c) => c.id === "bot:a");
  expect(zed).toMatchObject({ kind: "direct", botId: "a", unread: 1 });
  expect(zed?.lastMessage?.text).toBe("hello");
  expect(list.find((c) => c.id === "group:g")).toMatchObject({ kind: "group", groupId: "g" });
});

test("markRead then list reports unread 0", async () => {
  const h = engineHarness();
  h.addBot("a", "Ann");
  h.store.convMap.set("bot:a", { id: "bot:a", kind: "direct", botId: "a" });
  const id = await h.store.messages.append(fromBot("bot:a", "a", "hello"));
  expect((await h.client.conversations.list())[0]?.unread).toBe(1);
  expect(await h.client.conversations.markRead({ id: "bot:a", messageId: id })).toEqual({
    ok: true,
  });
  expect((await h.client.conversations.list())[0]?.unread).toBe(0);
});

test("messages: newest first, reply excerpt only from the same conversation", async () => {
  const h = engineHarness();
  h.store.convMap.set("bot:a", { id: "bot:a", kind: "direct", botId: "a" });
  h.store.convMap.set("bot:b", { id: "bot:b", kind: "direct", botId: "b" });
  const first = await h.store.messages.append(fromBot("bot:a", "a", "the question"));
  const other = await h.store.messages.append(fromBot("bot:b", "b", "secret"));
  await h.store.messages.append(owner("bot:a", "answer", first));
  await h.store.messages.append(owner("bot:a", "cross", other));
  const out = await h.client.conversations.messages({ id: "bot:a", limit: 10 });
  expect(out.map((m) => m.text)).toEqual(["cross", "answer", "the question"]);
  expect(out[0]?.replyTo).toBeUndefined();
  expect(out[1]?.replyTo).toMatchObject({ messageId: first, botId: "a", excerpt: "the question" });
  const page = await h.client.conversations.messages({ id: "bot:a", before: 4, limit: 1 });
  expect(page.map((m) => m.text)).toEqual(["answer"]);
});
