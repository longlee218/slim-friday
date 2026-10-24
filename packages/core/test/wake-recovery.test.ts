import { expect, test } from "bun:test";
import { CORE_DEFAULTS, INTERRUPTED_NOTE, type WakeRow } from "../src";
import { BotHub } from "../src/hub/bot-hub";
import { PermissionGate } from "../src/permission/permission-gate";
import { flush, makeHub } from "./bot-hub-harness";
import { FakeClock } from "./fakes/fake-clock";
import { FakeLog } from "./fakes/fake-log";
import { FakeRuntime } from "./fakes/fake-runtime";
import type { FakeStore } from "./fakes/fake-store";
import { FakeSurface } from "./fakes/fake-surface";
import { FakeToolCatalog } from "./fakes/fake-tool-catalog";

/** A wake row as an earlier run of the app left it. */
const row = (id: string, over: Partial<WakeRow> = {}): WakeRow => ({
  id,
  chainId: id,
  conversationId: "dc",
  targetBot: "editor",
  sender: { kind: "user" },
  intent: "request",
  hop: 0,
  text: `text ${id}`,
  status: "queued",
  attempts: 1,
  createdAt: 0,
  scopeKey: "s",
  priority: "interactive",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  ...over,
});

/** A new hub (a "restart") over the same store, with a fresh runtime, surface and log. */
function restart(store: FakeStore, now = 1000) {
  const runtime = new FakeRuntime();
  const surface = new FakeSurface();
  const clock = new FakeClock(now);
  const log = new FakeLog();
  const gate = new PermissionGate({
    store,
    surface,
    clock,
    catalog: new FakeToolCatalog([]),
    settings: () => ({ level: "balanced" }),
  });
  const hub = new BotHub({ runtime, surface, store, clock, gate, log });
  hub.start();
  return { runtime, surface, clock, log, hub };
}

/** The store of an app that ran before: the same bots, groups and conversations as the harness. */
function oldStore() {
  return makeHub().store;
}

test("a queued wake is delivered again as it was", async () => {
  const store = oldStore();
  await store.wakes.insert(row("w1"));
  const { hub, runtime, log } = restart(store);
  await hub.recover();
  await flush();
  expect(runtime.nth(0).sent[0]).toMatchObject({ text: "text w1", conversationId: "dc", hop: 0 });
  expect(runtime.nth(0).sent[0]?.interrupted).toBeUndefined();
  expect((await store.wakes.get("w1"))?.status).toBe("running");
  expect(log.of("wake.redelivered")).toHaveLength(1);
});

test("a running wake is sent again once with the interruption note and cuts 1", async () => {
  const store = oldStore();
  await store.wakes.insert(row("w1", { status: "running", startedAt: 5 }));
  const { hub, runtime } = restart(store);
  await hub.recover();
  await flush();
  expect(runtime.nth(0).sent[0]).toMatchObject({ text: "text w1", interrupted: true });
  expect((await store.wakes.get("w1"))?.cuts).toBe(1);
  expect(INTERRUPTED_NOTE).toContain("interrupted");
});

test("a running wake cut for the third time becomes interrupted and the conversation gets a notice", async () => {
  const store = oldStore();
  await store.wakes.insert(row("w1", { status: "running", cuts: 2 }));
  const { hub, runtime, surface } = restart(store);
  await hub.recover();
  await flush();
  expect(runtime.opened).toHaveLength(0);
  expect((await store.wakes.get("w1"))?.status).toBe("interrupted");
  expect(surface.posts.at(-1)?.message.text).toContain("interrupted");
});

test("a queued wake older than 24 hours becomes expired with a notice", async () => {
  const store = oldStore();
  await store.wakes.insert(row("w1", { createdAt: 0 }));
  const { hub, runtime, surface } = restart(store, CORE_DEFAULTS.wakeExpireMs + 1);
  await hub.recover();
  await flush();
  expect(runtime.opened).toHaveLength(0);
  expect((await store.wakes.get("w1"))?.status).toBe("expired");
  expect(surface.posts.at(-1)?.message.text).toContain("expired");
});

test("a wake whose bot or conversation is gone becomes dropped", async () => {
  const store = oldStore();
  await store.wakes.insert(row("w1", { targetBot: "ghost" }));
  await store.wakes.insert(row("w2", { conversationId: "gone" }));
  const { hub, runtime } = restart(store);
  await hub.recover();
  await flush();
  expect(runtime.opened).toHaveLength(0);
  expect((await store.wakes.get("w1"))?.status).toBe("dropped");
  expect((await store.wakes.get("w2"))?.status).toBe("dropped");
});

test("the hourly bot-message cap is rebuilt from the stored wakes", async () => {
  const store = oldStore();
  const bots = { kind: "bot", botId: "writer" } as const;
  for (let i = 0; i < CORE_DEFAULTS.maxBotMessagesPerConversationPerHour; i++)
    await store.wakes.insert(
      row(`old${i}`, {
        conversationId: "gc",
        sender: bots,
        status: "done",
        text: `m${i}`,
        createdAt: 900,
      }),
    );
  await store.wakes.insert(
    row("open", {
      conversationId: "gc",
      sender: bots,
      targetBot: "editor",
      text: "one more",
      createdAt: 990,
    }),
  );
  const { hub, runtime, surface } = restart(store);
  await hub.recover();
  await flush();
  expect(runtime.opened).toHaveLength(0);
  expect((await store.wakes.get("open"))?.status).toBe("blocked");
  expect(surface.posts.at(-1)?.message.text).toBe("Stopped: rate limit reached.");
});

test("a recovered wake still stops at the spend cap", async () => {
  const store = oldStore();
  await store.spend.add("editor", new Date(1000).toISOString().slice(0, 10), 999);
  await store.wakes.insert(row("w1"));
  const { hub, runtime } = restart(store);
  await hub.recover();
  await flush();
  expect(runtime.opened).toHaveLength(0);
  expect(await store.wakes.get("w1")).toMatchObject({ status: "blocked", blockReason: "spend" });
});

test("a row whose session will not open is retried later and the next one still runs", async () => {
  const store = oldStore();
  await store.wakes.insert(row("w1", { conversationId: "gc", targetBot: "writer" }));
  await store.wakes.insert(row("w2"));
  const { hub, runtime } = restart(store);
  const open = runtime.open.bind(runtime);
  let first = true;
  runtime.open = async (spec) => {
    if (first) {
      first = false;
      throw new Error("session will not open");
    }
    return open(spec);
  };
  await hub.recover();
  await flush();
  expect(await store.wakes.get("w1")).toMatchObject({ status: "queued", setupFailures: 1 });
  expect((await store.wakes.get("w2"))?.status).toBe("running");
});
