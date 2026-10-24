import { expect, test } from "bun:test";
import { backoffMs, CORE_DEFAULTS, type WakeRow } from "../src";
import { flush, makeHub, tick } from "./bot-hub-harness";

/** The only stored run (the tests start one run). */
const only = (h: ReturnType<typeof makeHub>): WakeRow => {
  const [w] = [...h.store.wakeMap.values()];
  if (!w) throw new Error("no run stored");
  return w;
};

/** A run an earlier boot left `running` in editor's direct scope. */
const leftRunning = (over: Partial<WakeRow> = {}): WakeRow => ({
  id: "w1",
  chainId: "w1",
  conversationId: "dc",
  targetBot: "editor",
  sender: { kind: "user" },
  intent: "request",
  hop: 0,
  text: "carry on",
  status: "running",
  attempts: 1,
  createdAt: 0,
  startedAt: 0,
  scopeKey: "editor",
  priority: "interactive",
  leaseOwner: "oldboot:main",
  leaseFence: 1,
  leaseExpiresAt: 300_000,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  ...over,
});

test("run opens with resume, posts text and ends done", async () => {
  const h = makeHub();
  await h.store.sessions.set("editor", "old");
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(h.runtime.resumed.map((r) => r.sessionId)).toEqual(["old"]);
  const s = h.runtime.last();
  expect(s.sent[0]).toMatchObject({ text: "hi", conversationId: "dc" });
  expect(only(h).status).toBe("running");
  s.emit({ type: "text", text: "hello owner" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(h.surface.posts.at(-1)?.message.text).toBe("hello owner");
  expect(only(h)).toMatchObject({ status: "done", resultText: "hello owner" });
  expect([...h.store.attemptMap.values()].map((a) => a.status)).toEqual(["done"]);
  expect(s.stopped).toBe(true);
  expect((await h.store.scopes.get("editor"))?.lastFinishedAt).toBe(0);
});

test("run waits for a background task and its follow-up turn before finishing", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "dig" });
  await flush();
  const s = h.runtime.last();
  s.emit({ type: "task_started", taskId: "t1", description: "research" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(only(h).status).toBe("running");
  expect(s.stopped).toBe(false);
  s.emit({ type: "task_done", taskId: "t1", status: "completed", summary: "found" });
  await flush();
  expect(only(h).status).toBe("running");
  s.emit({ type: "text", text: "the findings" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(only(h)).toMatchObject({ status: "done", resultText: "the findings" });
  expect(s.stopped).toBe(true);
});

test("typing is shown before the session opens", async () => {
  const h = makeHub();
  h.runtime.open = () => new Promise(() => {});
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(h.runtime.created).toHaveLength(0);
  expect(h.surface.activities).toContainEqual({
    conversationId: "dc",
    activity: { kind: "typing", botId: "editor" },
  });
});

test("reclaimed running row resumes with the cut note and cuts 1", async () => {
  const h = makeHub();
  await h.store.sessions.set("editor", "old");
  await h.store.wakes.insert(leftRunning());
  await h.hub.recover();
  await flush();
  expect(h.runtime.resumed[0]?.sessionId).toBe("old");
  expect(h.runtime.last().sent[0]).toMatchObject({ text: "carry on", interrupted: true });
  expect(only(h)).toMatchObject({ status: "running", cuts: 1, leaseFence: 2 });
});

test("third cut ends interrupted and tells the conversation", async () => {
  const h = makeHub();
  await h.store.wakes.insert(leftRunning({ cuts: 2 }));
  await h.hub.recover();
  await flush();
  expect(h.runtime.created).toHaveLength(0);
  expect(only(h)).toMatchObject({ status: "interrupted", cuts: 3 });
  const notice = h.surface.posts.at(-1)?.message;
  expect(notice?.author.kind).toBe("system");
  expect(notice?.text).toContain("interrupted");
});

test('transient error requeues with backoff, sixth gives up with "Send a message to continue."', async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  for (let n = 1; n <= CORE_DEFAULTS.transientRetries; n++) {
    h.runtime.last().emit({ type: "error", message: "overloaded", retryable: true });
    await flush();
    expect(only(h)).toMatchObject({
      status: "queued",
      transientRetries: n,
      wakeAt: h.clock.now() + backoffMs(n),
    });
    await tick(h.clock, backoffMs(n) + CORE_DEFAULTS.scanMs);
    expect(only(h).status).toBe("running");
  }
  expect(h.runtime.created).toHaveLength(CORE_DEFAULTS.transientRetries + 1);
  h.runtime.last().emit({ type: "error", message: "overloaded", retryable: true });
  await flush();
  expect(only(h)).toMatchObject({ status: "failed", error: "overloaded" });
  expect(h.surface.posts.at(-1)?.message.text).toContain("Send a message to continue.");
});

test("eighth setup failure ends failed", async () => {
  const h = makeHub();
  let tries = 0;
  h.runtime.open = async () => {
    tries++;
    throw new Error("workspace missing");
  };
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  for (let n = 1; n < CORE_DEFAULTS.setupFailures; n++) {
    expect(only(h)).toMatchObject({ status: "queued", setupFailures: n });
    await tick(h.clock, backoffMs(n) + CORE_DEFAULTS.scanMs);
  }
  expect(tries).toBe(CORE_DEFAULTS.setupFailures);
  expect(only(h).status).toBe("failed");
  expect(h.surface.posts.at(-1)?.message.text).toContain("Send a message to continue.");
});

test("watchdog aborts after 180 s without events but not during a long tool call", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "build it" });
  await flush();
  const s = h.runtime.last();
  s.emit({ type: "tool_call", toolUseId: "b1", tool: "Bash", input: { command: "make" } });
  await flush();
  await tick(h.clock, CORE_DEFAULTS.streamIdleMs + 20_000);
  expect(s.stopped).toBe(false);
  expect(only(h).status).toBe("running");
  s.emit({ type: "tool_result", toolUseId: "b1", ok: true });
  await flush();
  await tick(h.clock, CORE_DEFAULTS.streamIdleMs);
  expect(s.stopped).toBe(true);
  expect(only(h)).toMatchObject({ status: "queued", transientRetries: 1 });
});

test("resetPending opens a fresh session", async () => {
  const h = makeHub();
  await h.store.sessions.set("editor", "old");
  await h.store.scopes.markReset("editor");
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(h.runtime.resumed).toEqual([]);
  expect(h.runtime.opened).toHaveLength(1);
  expect(await h.store.sessions.get("editor")).toBe(h.runtime.nth(0).id);
  expect((await h.store.scopes.get("editor"))?.resetPending).toBe(false);
});

test("a lost lease stops the session and writes no finish", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const s = h.runtime.last();
  // Another worker took the run over.
  only(h).leaseFence = 9;
  await tick(h.clock, CORE_DEFAULTS.fenceCheckMs);
  expect(s.stopped).toBe(true);
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(only(h)).toMatchObject({ status: "running", leaseFence: 9 });
  expect([...h.store.attemptMap.values()].map((a) => a.status)).toEqual(["interrupted"]);
});
