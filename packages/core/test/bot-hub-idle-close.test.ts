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

test.todo("sweepIdle reports the conversations the session answered and when it opened (restored in Task 8)", async () => {
  const { surface, runtime, clock, hub, seen } = hubWithHook();
  clock.advance(1_000);
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const s = runtime.nth(0);
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  clock.advance(CORE_DEFAULTS.idleCloseMs);
  await hub.sweepIdle();
  expect(seen).toEqual([{ botId: "editor", key: "editor", conversationIds: ["dc"], since: 1_000 }]);
  expect(hub.status()).toEqual([]);
});

test.todo("a session closed by stop() or a crash is not reported (restored in Task 8)", async () => {
  const stopped = hubWithHook();
  stopped.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  stopped.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  await stopped.hub.stop("editor");
  stopped.clock.advance(CORE_DEFAULTS.idleCloseMs);
  await stopped.hub.sweepIdle();
  const crashed = hubWithHook();
  crashed.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  crashed.runtime.nth(0).emit({ type: "error", message: "boom", retryable: false });
  await flush();
  crashed.clock.advance(CORE_DEFAULTS.idleCloseMs);
  await crashed.hub.sweepIdle();
  expect([...stopped.seen, ...crashed.seen]).toEqual([]);
});

test.todo("a hook that throws is logged and the session still closes (restored in Task 8)", async () => {
  const { surface, runtime, clock, hub, log } = hubWithHook(() => {
    throw new Error("flush down");
  });
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  clock.advance(CORE_DEFAULTS.idleCloseMs);
  await hub.sweepIdle();
  await flush();
  expect(hub.status()).toEqual([]);
  expect(log.of("hub.idle_close_hook")).toHaveLength(1);
});
