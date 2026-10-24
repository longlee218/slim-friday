import { expect, test } from "bun:test";
import { flush, makeHub } from "./bot-hub-harness";

test.todo("the woken bot gets the quote; a reply to another conversation's message is ignored (restored in Task 8)", async () => {
  const { runtime, surface, store } = makeHub();
  await store.messages.append({
    conversationId: "gc",
    author: { kind: "bot", botId: "editor" },
    text: "draft ready",
    at: 1,
  });
  await store.messages.append({
    conversationId: "dc",
    author: { kind: "bot", botId: "editor" },
    text: "elsewhere",
    at: 2,
  });
  await surface.deliver({ conversationId: "gc", text: "tweak it", replyTo: 1 });
  await flush();
  const turn = runtime.nth(0).sent[0];
  expect(runtime.nth(0).spec.bot.id).toBe("editor");
  expect(turn?.quote).toEqual({ author: { kind: "bot", botId: "editor" }, text: "draft ready" });
  expect(store.msgs.at(-1)).toMatchObject({ text: "tweak it", replyTo: 1 });

  // Another conversation's message: entry bot, no quote.
  await surface.deliver({ conversationId: "gc", text: "hello", replyTo: 2 });
  await flush();
  const writer = runtime.opened.find((s) => s.spec.bot.id === "writer");
  expect(writer).toBeDefined();
  expect(writer?.sent[0]?.text).toBe("hello");
  expect(writer?.sent[0]?.quote).toBeUndefined();
  const editor = runtime.opened.find((s) => s.spec.bot.id === "editor");
  expect(editor?.sent.some((t) => t.text === "hello")).toBe(false);
});

test.todo("a reply to the owner's own message goes to the entry bot and keeps the quote (restored in Task 8)", async () => {
  const { runtime, surface, store } = makeHub();
  await store.messages.append({
    conversationId: "gc",
    author: { kind: "user" },
    text: "idea",
    at: 1,
  });
  await surface.deliver({ conversationId: "gc", text: "more", replyTo: 1 });
  await flush();
  expect(runtime.nth(0).spec.bot.id).toBe("writer");
  expect(runtime.nth(0).sent[0]?.quote).toEqual({ author: { kind: "user" }, text: "idea" });
});
