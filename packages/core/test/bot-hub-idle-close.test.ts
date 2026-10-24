import { expect, test } from "bun:test";
import { CORE_DEFAULTS, type IdleClose } from "../src";
import { flush, makeHub } from "./bot-hub-harness";

/** A hub whose idle-close hook records what it is told. */
function hubWithHook(hook?: (e: IdleClose) => void) {
  const seen: IdleClose[] = [];
  const h = makeHub(undefined, {
    onIdleClose: (e) => {
      seen.push(e);
      hook?.(e);
    },
  });
  return { ...h, seen };
}

test("sweepIdle reports a quiet scope's conversations and its last flush time, once", async () => {
  const { surface, runtime, clock, hub, seen } = hubWithHook();
  clock.advance(1_000);
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const s = runtime.nth(0);
  // A run takes time: it ends after it started.
  clock.advance(10);
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  clock.advance(CORE_DEFAULTS.idleCloseMs);
  await hub.sweepIdle();
  // Never flushed before: the messages since the run was created (incl. its trigger) are new, not the whole history.
  expect(seen).toEqual([{ botId: "editor", key: "editor", conversationIds: ["dc"], since: 999 }]);
  expect(await hub.status()).toEqual([]);
  await hub.sweepIdle();
  expect(seen).toHaveLength(1);
});

test("a scope whose run was stopped or crashed is reported once it is quiet", async () => {
  const stopped = hubWithHook();
  stopped.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  stopped.clock.advance(10);
  await stopped.hub.stop("editor");
  stopped.clock.advance(CORE_DEFAULTS.idleCloseMs);
  await stopped.hub.sweepIdle();
  const crashed = hubWithHook();
  crashed.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  crashed.clock.advance(10);
  crashed.runtime.nth(0).emit({ type: "error", message: "boom", retryable: false });
  await flush();
  crashed.clock.advance(CORE_DEFAULTS.idleCloseMs);
  await crashed.hub.sweepIdle();
  expect([...stopped.seen, ...crashed.seen].map((e) => e.key)).toEqual(["editor", "editor"]);
});

test("a hook that throws is logged and the session still closes", async () => {
  const { surface, runtime, clock, hub, log } = hubWithHook(() => {
    throw new Error("flush down");
  });
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  clock.advance(10);
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  clock.advance(CORE_DEFAULTS.idleCloseMs);
  await hub.sweepIdle();
  await flush();
  expect(await hub.status()).toEqual([]);
  expect(log.of("hub.idle_close_hook")).toHaveLength(1);
});

test("quiet scope is flushed once: a failed flush is retried, a successful one is not repeated", async () => {
  let calls = 0;
  const { surface, runtime, clock, hub, store } = hubWithHook(() => {
    if (++calls === 1) throw new Error("flush down");
  });
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  clock.advance(10);
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  clock.advance(CORE_DEFAULTS.idleCloseMs);
  await hub.sweepIdle();
  expect(calls).toBe(1);
  // The failure left the scope unflushed, so the next sweep tries again.
  await hub.sweepIdle();
  expect(calls).toBe(2);
  expect((await store.scopes.get("editor"))?.lastFlushedAt).toBeGreaterThan(0);
  await hub.sweepIdle();
  expect(calls).toBe(2);
});

test("a flush that keeps failing is given up after three tries", async () => {
  let calls = 0;
  const { surface, runtime, clock, hub, store } = hubWithHook(() => {
    calls++;
    throw new Error("flush down");
  });
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  clock.advance(10);
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  clock.advance(CORE_DEFAULTS.idleCloseMs);
  for (let i = 0; i < 5; i++) await hub.sweepIdle();
  expect(calls).toBe(3);
  expect((await store.scopes.get("editor"))?.lastFlushedAt).toBeGreaterThan(0);
});
