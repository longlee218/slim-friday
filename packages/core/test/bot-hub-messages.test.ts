import { expect, test } from "bun:test";
import { CORE_DEFAULTS } from "../src";
import { flush, makeHub } from "./bot-hub-harness";

const ref = { fileId: "f1", name: "a.png", mimeType: "image/png", size: 3 };
const att = { name: "1-a.png", mimeType: "image/png", path: "/inbox/dc/1/1-a.png", size: 3 };

test("every post carries the stored id", async () => {
  const { runtime, surface, store } = makeHub();
  const id = await surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  runtime.nth(0).emit({ type: "text", text: "one" });
  runtime.nth(0).emit({ type: "text", text: "two" });
  await flush();
  const posts = surface.posts.map((p) => p.message);
  expect(posts.map((m) => m.text)).toEqual(["one", "two"]);
  for (const m of posts) expect(store.msgs[m.id - 1]).toMatchObject({ text: m.text });
  expect(posts[0]?.id).toBe((id ?? 0) + 1);
  expect(posts[1]?.id).toBeGreaterThan(posts[0]?.id ?? 0);
});

test("handle returns the id of the owner's message and stores files", async () => {
  const { surface, store, runtime } = makeHub();
  const id = await surface.deliver({
    conversationId: "dc",
    text: "",
    files: [ref],
    attachments: [att],
  });
  await flush();
  expect(store.msgs[(id ?? 0) - 1]).toMatchObject({ kind: "file", files: [ref], text: "" });
  expect(runtime.nth(0).sent[0]?.text).toBe("(sent 1 file(s))");
});

test("replyTo is stored; text with files stays kind text", async () => {
  const { surface, store } = makeHub();
  await surface.deliver({ conversationId: "dc", text: "see", files: [ref], replyTo: 7 });
  expect(store.msgs.at(-1)).toMatchObject({ kind: "text", replyTo: 7, files: [ref] });
});

test("an unknown conversation returns undefined and stores nothing", async () => {
  const { surface, store } = makeHub();
  expect(await surface.deliver({ conversationId: "nope", text: "x" })).toBeUndefined();
  expect(store.msgs).toHaveLength(0);
});

test("system notices are stored too", async () => {
  const { runtime, surface, store } = makeHub();
  await surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  runtime.opened[0]?.emit({ type: "turn_end", costUsd: CORE_DEFAULTS.maxSpendPerBotPerDayUsd });
  await flush();
  await surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  const post = surface.posts.find((p) => p.message.author.kind === "system")?.message;
  expect(post?.text).toBe("Stopped: spend limit reached.");
  expect(store.msgs[(post?.id ?? 0) - 1]).toMatchObject({ author: { kind: "system" } });
});

test("SendToBot and HandOff are stored and posted as relays", async () => {
  const { surface, store, hub } = makeHub();
  // distinct texts: the same text twice inside the window is refused
  const send = (intent: "request" | "status", text: string, handoff?: boolean) =>
    hub.send("writer@g", { to: "editor", text, intent, ...(handoff && { handoff }) });
  await surface.deliver({ conversationId: "gc", text: "go" });
  await flush();
  await send("request", "check it");
  await send("request", "take over", true);
  await send("status", "half done");
  await flush();
  const relays = surface.posts.map((p) => p.message).filter((m) => m.kind === "relay");
  const base = { fromBotId: "writer", toBotId: "editor" };
  expect(relays.map((m) => m.relay)).toEqual([
    { ...base, intent: "request" },
    { ...base, intent: "handoff" },
    { ...base, intent: "request", state: "status" },
  ]);
  expect(relays[0]).toMatchObject({ text: "check it", author: { kind: "bot", botId: "writer" } });
  expect(store.msgs[(relays[0]?.id ?? 0) - 1]).toMatchObject({ kind: "relay" });
});

test("a post that fails keeps the stored row", async () => {
  const { surface, store } = makeHub();
  surface.post = async () => {
    throw new Error("down");
  };
  await surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  // the user message is kept even when later posts fail
  expect(store.msgs[0]).toMatchObject({ text: "hi" });
});
