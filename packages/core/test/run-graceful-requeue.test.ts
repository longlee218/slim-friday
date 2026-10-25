import { expect, test } from "bun:test";
import type { WakeRow } from "../src";
import { flush, makeHub } from "./bot-hub-harness";

/** The only stored run (the tests start one run). */
const only = (h: ReturnType<typeof makeHub>): WakeRow => {
  const [w] = [...h.store.wakeMap.values()];
  if (!w) throw new Error("no run stored");
  return w;
};

test("a graceful shutdown requeues the running run without counting a cut", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "long job" });
  await flush();
  const s = h.runtime.last();
  expect(only(h).status).toBe("running");
  await h.hub.stopAll();
  expect(s.stopped).toBe(true);
  const row = only(h);
  expect(row).toMatchObject({ status: "queued", cuts: 0, leaseFence: 1 });
  expect(row.wakeAt ?? 0).toBeLessThanOrEqual(h.clock.now());
  expect([...h.store.attemptMap.values()].map((a) => a.status)).toEqual(["interrupted"]);
});

test("the next claim after a graceful requeue adds the cut note and keeps cuts", async () => {
  const h = makeHub();
  await h.store.sessions.set("editor", "old");
  await h.store.wakes.insert({
    id: "w1",
    chainId: "w1",
    conversationId: "dc",
    targetBot: "editor",
    sender: { kind: "user" },
    intent: "request",
    hop: 0,
    text: "carry on",
    status: "queued",
    attempts: 1,
    createdAt: 0,
    startedAt: 0,
    scopeKey: "editor",
    priority: "interactive",
    leaseOwner: "oldboot:w0",
    leaseFence: 1,
    cuts: 0,
    transientRetries: 0,
    setupFailures: 0,
    nudges: 0,
  });
  await h.store.attempts.start({
    id: "w1:1",
    wakeId: "w1",
    fence: 1,
    owner: "oldboot:w0",
    startedAt: 0,
  });
  await h.store.attempts.finish("w1:1", "interrupted", 0);
  await h.hub.recover();
  await flush();
  expect(h.runtime.resumed[0]?.sessionId).toBe("old");
  expect(h.runtime.last().sent[0]).toMatchObject({ text: "carry on", interrupted: true });
  expect(only(h)).toMatchObject({ status: "running", cuts: 0, leaseFence: 2, tainted: true });
});

test("a run requeued after a transient failure gets no cut note", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  h.runtime.last().emit({ type: "error", message: "overloaded", retryable: true });
  await flush();
  expect(only(h).status).toBe("queued");
  h.clock.advance(60_000);
  await flush();
  expect(only(h).status).toBe("running");
  expect(h.runtime.last().sent[0]?.interrupted).toBeUndefined();
});
