import { expect, test } from "bun:test";
import { CORE_DEFAULTS } from "../src";
import { flush, makeHub } from "./bot-hub-harness";

test("direct message opens one session, hop 0, empty context; the bot's text is posted and stored", async () => {
  const { runtime, surface, store } = makeHub();
  surface.deliver({ conversationId: "dc", text: "hello" });
  await flush();
  expect(runtime.opened).toHaveLength(1);
  const s = runtime.nth(0);
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0]).toMatchObject({ conversationId: "dc", hop: 0, context: [], text: "hello" });
  s.emit({ type: "text", text: "hi there" });
  await flush();
  expect(surface.posts.at(-1)).toMatchObject({
    conversationId: "dc",
    message: { author: { kind: "bot", botId: "editor" }, text: "hi there" },
  });
  expect(store.msgs.at(-1)?.text).toBe("hi there");
});

test("group message with no mention wakes only the entry bot, with the group context", async () => {
  const { runtime, surface, store } = makeHub();
  for (let i = 0; i < 25; i++)
    store.msgs.push({ conversationId: "gc", author: { kind: "user" }, text: `old${i}`, at: i });
  surface.deliver({ conversationId: "gc", text: "plan a video" });
  await flush();
  expect(runtime.opened).toHaveLength(1);
  expect(runtime.opened[0]?.spec.bot.id).toBe("writer");
  const turn = runtime.nth(0).sent[0];
  if (!turn) throw new Error("no turn sent");
  expect(turn.context).toHaveLength(CORE_DEFAULTS.groupContextMessages);
  expect(turn.context.at(-1)?.text).toBe("plan a video");
});

test("a bot reply that mentions a member hands off with hop + 1; nobody else wakes", async () => {
  const { runtime, surface } = makeHub();
  surface.deliver({ conversationId: "gc", text: "make it" });
  await flush();
  runtime.opened[0]?.emit({ type: "text", text: "@editor please check" });
  await flush();
  expect(runtime.opened).toHaveLength(2);
  expect(runtime.opened[1]?.spec.bot.id).toBe("editor");
  expect(runtime.opened[1]?.sent[0]).toMatchObject({ hop: 1, conversationId: "gc" });
});

test("a second message to the same bot reuses the open session", async () => {
  const { runtime, surface } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(runtime.opened).toHaveLength(1);
  expect(runtime.opened[0]?.sent).toHaveLength(2);
});

test("a crashing session is dropped, a notice is posted, the next message resumes with the stored id", async () => {
  const { runtime, surface, hub } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  const first = runtime.nth(0);
  first.fail(new Error("crash"));
  await flush();
  expect(surface.posts.some((p) => p.message.author.kind === "system")).toBe(true);
  expect(hub.status()).toEqual([]);
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(runtime.resumed).toHaveLength(1);
  expect(runtime.resumed[0]?.sessionId).toBe(first.id);
  expect(runtime.resumed[0]?.session.sent[0]?.text).toBe("two");
});

test("status lists running tasks; text after task_done goes to the conversation that started the task", async () => {
  const { runtime, surface, hub } = makeHub();
  surface.deliver({ conversationId: "dc", text: "research this" });
  await flush();
  const s = runtime.nth(0);
  s.emit({ type: "task_started", taskId: "t1", description: "dig" });
  await flush();
  expect(hub.status()[0]?.tasks).toEqual([{ taskId: "t1", description: "dig" }]);
  // the same bot is now asked in the group chat meanwhile
  surface.deliver({ conversationId: "gc", text: "@editor quick question" });
  await flush();
  s.emit({ type: "task_done", taskId: "t1", status: "completed", summary: "found" });
  await flush();
  expect(hub.status()[0]?.tasks).toEqual([]);
  s.emit({ type: "text", text: "the research result" });
  await flush();
  expect(surface.posts.at(-1)?.conversationId).toBe("dc");
});

test("a tool decision made by a task asks in the conversation that started the task", async () => {
  const { runtime, surface } = makeHub();
  surface.deliver({ conversationId: "dc", text: "go" });
  await flush();
  const s = runtime.nth(0);
  s.emit({ type: "task_started", taskId: "t1", description: "dig" });
  await flush();
  surface.deliver({ conversationId: "gc", text: "@editor other chat" });
  await flush();
  surface.answerWith("once");
  await s.spec.decide({ tool: "Unknown", input: {}, taskId: "t1" });
  expect(surface.approvals.at(-1)?.conversationId).toBe("dc");
  await s.spec.decide({ tool: "Unknown", input: {} });
  expect(surface.approvals.at(-1)?.conversationId).toBe("gc");
});

test("sweepIdle closes a quiet session; the next message resumes it", async () => {
  const { runtime, surface, hub, clock } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  runtime.opened[0]?.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  clock.advance(CORE_DEFAULTS.idleCloseMs);
  await hub.sweepIdle();
  expect(runtime.opened[0]?.stopped).toBe(true);
  expect(hub.status()).toEqual([]);
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(runtime.resumed).toHaveLength(1);
});

test("sweepIdle keeps a session that has a running task", async () => {
  const { runtime, surface, hub, clock } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  runtime.opened[0]?.emit({ type: "task_started", taskId: "t1", description: "long" });
  runtime.opened[0]?.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  clock.advance(CORE_DEFAULTS.idleCloseMs * 2);
  await hub.sweepIdle();
  expect(runtime.opened[0]?.stopped).toBe(false);
});

test("stop ends the session and status no longer lists it", async () => {
  const { runtime, surface, hub } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  await hub.stop("editor");
  expect(runtime.opened[0]?.stopped).toBe(true);
  expect(hub.status()).toEqual([]);
});
