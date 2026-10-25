import { expect, test } from "bun:test";
import { CORE_DEFAULTS } from "../src";
import { flush, makeHub, tick } from "./bot-hub-harness";

test("direct message opens one session, hop 0, empty context; the bot's text is posted and stored", async () => {
  const { runtime, surface, store } = makeHub();
  surface.deliver({ conversationId: "dc", text: "hello" });
  await flush();
  expect(runtime.opened).toHaveLength(1);
  const s = runtime.nth(0);
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0]).toMatchObject({ conversationId: "dc", hop: 0, context: [], text: "hello" });
  s.emit({ type: "text", text: "hi there" });
  s.emit({ type: "turn_end", costUsd: 0 });
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

test("a bot's SendToBot wakes a member with hop + 1; nobody else wakes", async () => {
  const { runtime, surface, hub } = makeHub();
  surface.deliver({ conversationId: "gc", text: "make it" });
  await flush();
  await hub.send("writer@g", { to: "editor", text: "please check", intent: "request" });
  await flush();
  expect(runtime.opened).toHaveLength(2);
  expect(runtime.opened[1]?.spec.bot.id).toBe("editor");
  expect(runtime.opened[1]?.sent[0]).toMatchObject({ hop: 1, conversationId: "gc" });
});

test("a second message to the same bot resumes the stored session in a new run", async () => {
  const { runtime, surface } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(runtime.opened).toHaveLength(1);
  expect(runtime.resumed.map((r) => r.sessionId)).toEqual([runtime.nth(0).id]);
  expect(runtime.last().sent.map((t) => t.text)).toEqual(["two"]);
});

test("a crashing session is dropped, a notice is posted, the next message resumes with the stored id", async () => {
  const { runtime, surface, hub } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  const first = runtime.nth(0);
  first.fail(new Error("crash"));
  await flush();
  expect(surface.posts.some((p) => p.message.author.kind === "system")).toBe(true);
  expect(await hub.status()).toEqual([]);
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(runtime.resumed).toHaveLength(1);
  expect(runtime.resumed[0]?.sessionId).toBe(first.id);
  expect(runtime.resumed[0]?.session.sent[0]?.text).toBe("two");
});

test("status lists running tasks; text after task_done goes to the conversation that started the task", async () => {
  const { runtime, surface, hub, store } = makeHub();
  // A second chat of the same group shares editor's group session.
  store.convMap.set("gc2", { id: "gc2", kind: "group", groupId: "g" });
  const editorTasks = async () =>
    (await hub.status()).find((r) => r.botId === "editor" && r.groupId === "g")?.tasks;
  surface.deliver({ conversationId: "gc2", text: "@editor research this" });
  await flush();
  const s = runtime.nth(0);
  s.emit({ type: "task_started", taskId: "t1", description: "dig" });
  await flush();
  expect(await editorTasks()).toEqual([{ taskId: "t1", description: "dig" }]);
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  // the same session is now asked in the other chat of the group meanwhile
  surface.deliver({ conversationId: "gc", text: "@editor quick question" });
  await flush();
  // The scope is held by the task's run: the other chat's message waits as a queued run.
  expect(runtime.created).toHaveLength(1);
  expect([...store.wakeMap.values()].map((w) => w.status)).toEqual(["running", "queued"]);
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  s.emit({ type: "task_done", taskId: "t1", status: "completed", summary: "found" });
  await flush();
  expect(await editorTasks()).toEqual([]);
  s.emit({ type: "text", text: "the research result" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(surface.posts.at(-1)?.conversationId).toBe("gc2");
});

test("a tool decision made by a task asks in the conversation that started the task", async () => {
  const { runtime, surface, store, hub } = makeHub();
  // A second chat of the same group shares editor's group scope.
  store.convMap.set("gc2", { id: "gc2", kind: "group", groupId: "g" });
  surface.deliver({ conversationId: "gc2", text: "@editor go" });
  await flush();
  const s = runtime.nth(0);
  s.emit({ type: "task_started", taskId: "t1", description: "dig" });
  await flush();
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  // The scope is busy with the task: the other chat's message waits as a queued run.
  surface.deliver({ conversationId: "gc", text: "@editor other chat" });
  await flush();
  expect(runtime.created).toHaveLength(1);
  expect([...store.wakeMap.values()].map((w) => w.status)).toEqual(["running", "queued"]);
  const first = s.spec.decide({ tool: "Unknown", input: {}, taskId: "t1" });
  await flush();
  expect(surface.shown.at(-1)?.card.conversationId).toBe("gc2");
  await hub.answerCard(surface.shown.at(-1)?.card.id ?? "", "once");
  expect(await first).toEqual({ behavior: "allow" });
  void s.spec.decide({ tool: "Unknown", input: {} });
  await flush();
  expect(surface.shown).toHaveLength(2);
  expect(surface.shown.at(-1)?.card.conversationId).toBe("gc2");
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
  expect(await hub.status()).toEqual([]);
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
  expect(await hub.status()).toEqual([]);
});

test("I1: a message to a busy session waits for the end of its turn; the answer goes where it was asked", async () => {
  const { runtime, surface, store } = makeHub();
  // A second chat of the same group shares the bot's group scope.
  store.convMap.set("gc2", { id: "gc2", kind: "group", groupId: "g" });
  surface.deliver({ conversationId: "gc2", text: "@editor secret plan" });
  await flush();
  surface.deliver({ conversationId: "gc", text: "@editor hi group" });
  await flush();
  const s = runtime.nth(0);
  expect(runtime.turns()).toHaveLength(1); // the group message is a queued run, not sent
  s.emit({ type: "text", text: "dm answer" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(surface.posts.find((p) => p.message.text === "dm answer")?.conversationId).toBe("gc2");
  const next = runtime.last();
  expect(runtime.turns()).toHaveLength(2);
  expect(next.sent[0]).toMatchObject({ conversationId: "gc" });
  next.emit({ type: "text", text: "group answer" });
  next.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(surface.posts.find((p) => p.message.text === "group answer")?.conversationId).toBe("gc");
});

test("I2: a stored session that cannot be resumed is cleared and a fresh session opens", async () => {
  const { runtime, surface, store } = makeHub();
  store.sessionMap.set("editor", "stale");
  runtime.resume = async () => {
    throw new Error("gone");
  };
  surface.deliver({ conversationId: "dc", text: "hello" });
  await flush();
  expect(runtime.opened).toHaveLength(1);
  expect(store.sessionMap.get("editor")).toBe(runtime.nth(0).id);
});

test("I2: a session that will not open is retried as a setup failure, then the owner is told", async () => {
  const { runtime, surface, clock } = makeHub();
  runtime.open = async () => {
    throw new Error("cannot start");
  };
  surface.deliver({ conversationId: "dc", text: "hello" });
  await flush();
  expect(surface.posts.some((p) => p.message.author.kind === "system")).toBe(false);
  for (let n = 1; n < CORE_DEFAULTS.setupFailures; n++) await tick(clock, 70_000);
  expect(surface.posts.some((p) => p.message.text.includes("cannot start"))).toBe(true);
});

test("I3: an error event stops the session so it cannot run twice on one transcript", async () => {
  const { runtime, surface, hub } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  runtime.nth(0).emit({ type: "error", message: "boom", retryable: false });
  await flush();
  expect(runtime.nth(0).stopped).toBe(true);
  expect(await hub.status()).toEqual([]);
  expect(surface.posts.some((p) => p.message.author.kind === "system")).toBe(true);
});

test("I6: a tool decision made while the session opens asks in the run's conversation", async () => {
  const { runtime, surface } = makeHub();
  let early: unknown;
  const open = runtime.open.bind(runtime);
  runtime.open = async (spec) => {
    early = await spec.decide({ tool: "X", input: {} });
    return open(spec);
  };
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  expect(early).toMatchObject({ behavior: "park" });
  expect(surface.shown.map((a) => a.card.conversationId)).toEqual(["dc"]);
});

test("the session spec tells the runtime which conversation the bot answers now", async () => {
  const { runtime, surface } = makeHub();
  surface.deliver({ conversationId: "dc", text: "hello" });
  await flush();
  const s = runtime.nth(0);
  expect(s.spec.currentConversation?.()).toBe("dc");
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(s.spec.currentConversation?.()).toBeUndefined();
});

test("a send that throws does not leave the bot busy: the owner is told and the next message goes through", async () => {
  const { runtime, surface } = makeHub();
  runtime.onTurn = (s, turn) => {
    if (turn.text === "two") throw new Error("disk full");
    s.emit({ type: "turn_end", costUsd: 0 });
  };
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(surface.posts.some((p) => p.message.text.includes("disk full"))).toBe(true);
  surface.deliver({ conversationId: "dc", text: "three" });
  await flush();
  expect(runtime.last().sent.at(-1)?.text).toBe("three");
});
