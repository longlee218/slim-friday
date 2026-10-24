import { expect, test } from "bun:test";
import { flush, makeHub } from "./bot-hub-harness";

test.todo("a user message creates a wake that is running while the turn lasts and done at turn_end (restored in Task 8)", async () => {
  const { runtime, surface, store, log } = makeHub();
  surface.deliver({ conversationId: "dc", text: "hello" });
  await flush();
  const [row] = [...store.wakeMap.values()];
  expect(row).toMatchObject({
    conversationId: "dc",
    targetBot: "editor",
    sender: { kind: "user" },
    intent: "request",
    hop: 0,
    text: "hello",
    status: "running",
    attempts: 1,
  });
  expect(row?.chainId).toBe(row?.id);
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect([...store.wakeMap.values()][0]?.status).toBe("done");
  expect(log.lines.map((l) => l.msg)).toEqual(["wake.queued", "wake.started", "wake.done"]);
});

test.todo("wake.done carries queue_wait_ms, first_response_ms and total_ms from the clock (restored in Task 8)", async () => {
  const { runtime, surface, clock, log } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  clock.advance(100);
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  clock.advance(50);
  runtime.nth(0).emit({ type: "text", text: "answer" });
  await flush();
  clock.advance(50);
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  const second = log.of("wake.done")[1];
  expect(second?.fields).toMatchObject({
    botId: "editor",
    queue_wait_ms: 100,
    first_response_ms: 150,
    total_ms: 200,
  });
});

test.todo("a message sent while the bot is busy stays queued until the turn ends (restored in Task 8)", async () => {
  const { runtime, surface, store } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  const status = () => [...store.wakeMap.values()].map((w) => `${w.text}:${w.status}`);
  expect(status()).toEqual(["one:running", "two:queued"]);
  expect(runtime.nth(0).sent).toHaveLength(1);
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(status()).toEqual(["one:done", "two:running"]);
});

test("a wake stopped by the spend cap is stored as blocked with its reason", async () => {
  const { surface, store, log } = makeHub();
  await store.spend.add("editor", new Date(0).toISOString().slice(0, 10), 999);
  surface.deliver({ conversationId: "dc", text: "hello" });
  await flush();
  expect([...store.wakeMap.values()][0]).toMatchObject({ status: "blocked", blockReason: "spend" });
  expect(log.of("wake.blocked")[0]?.fields).toMatchObject({ blockReason: "spend" });
});

test.todo("a crashed session marks its running wake interrupted and drops the queued ones (restored in Task 8)", async () => {
  const { runtime, surface, store } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  runtime.nth(0).fail(new Error("boom"));
  await flush();
  expect([...store.wakeMap.values()].map((w) => `${w.text}:${w.status}`)).toEqual([
    "one:interrupted",
    "two:dropped",
  ]);
});

test("a failed delivery notice is logged instead of swallowed", async () => {
  const { surface, store, log } = makeHub();
  store.conversations.get = async () => {
    throw new Error("db down");
  };
  surface.post = async () => {
    throw new Error("post down");
  };
  surface.deliver({ conversationId: "dc", text: "hello" });
  await flush();
  expect(log.of("hub.notice_failed")[0]).toMatchObject({ level: "error" });
});
