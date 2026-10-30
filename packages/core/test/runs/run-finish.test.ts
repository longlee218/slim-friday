import { expect, test } from "bun:test";
import type { BotId, WakeRow } from "../../src";
import { flush, makeHub } from "../bot-hub-harness";

/** A hub whose computer releases are recorded as [botId, wakeId] (and throw when `fail`). */
function hubWithRelease(fail = false) {
  const released: [BotId, string][] = [];
  const h = makeHub(undefined, {
    computerRelease: async (botId, wakeId) => {
      released.push([botId, wakeId]);
      if (fail) throw new Error("docker gone");
    },
  });
  return { ...h, released };
}

const onlyRun = (h: ReturnType<typeof makeHub>): WakeRow => {
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
  nudges: 0,
  ...over,
});

test("a done run releases the computer once, for its own wake", async () => {
  const h = hubWithRelease();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(h.released).toEqual([]);
  h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(onlyRun(h).status).toBe("done");
  expect(h.released).toEqual([["editor", onlyRun(h).id]]);
});

test("a failed run releases the computer once, for its own wake", async () => {
  const h = hubWithRelease();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  h.runtime.last().emit({ type: "error", message: "broken", retryable: false });
  await flush();
  expect(onlyRun(h).status).toBe("failed");
  expect(h.released).toEqual([["editor", onlyRun(h).id]]);
});

test("a lost finish transition (another worker owns the run) releases nothing", async () => {
  const h = hubWithRelease();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  onlyRun(h).leaseFence = 9;
  h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(onlyRun(h).status).toBe("running");
  expect(h.released).toEqual([]);
});

test("an owner Stop (cancelled) releases the computer once, for its own wake", async () => {
  const h = hubWithRelease();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  await h.hub.stop("editor");
  await flush();
  expect(onlyRun(h).status).toBe("cancelled");
  expect(h.released).toEqual([["editor", onlyRun(h).id]]);
});

test("a run that ends interrupted by restarts releases the computer once", async () => {
  const h = hubWithRelease();
  await h.store.wakes.insert(leftRunning({ cuts: 2 }));
  await h.hub.recover();
  await flush();
  expect(onlyRun(h).status).toBe("interrupted");
  expect(h.released).toEqual([["editor", "w1"]]);
});

test("a dropped run (its conversation is gone) releases the computer once", async () => {
  const h = hubWithRelease();
  await h.store.wakes.insert(leftRunning({ conversationId: "gone" }));
  await h.hub.recover();
  await flush();
  expect(onlyRun(h).status).toBe("dropped");
  expect(h.released).toEqual([["editor", "w1"]]);
});

test("a throwing release is logged and the run still finishes", async () => {
  const h = hubWithRelease(true);
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  h.runtime.last().emit({ type: "text", text: "ok" });
  h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(onlyRun(h).status).toBe("done");
  expect(h.surface.posts.at(-1)?.message.text).toBe("ok");
  expect(h.released).toHaveLength(1);
  expect(h.log.of("computer.release_failed")[0]?.fields).toMatchObject({
    botId: "editor",
    wakeId: onlyRun(h).id,
    err: "docker gone",
  });
});

test("the computer facts reach the spec of a bot with a computer", async () => {
  const h = makeHub(undefined, { computerSlotsText: () => "1 slot, limited by memory" });
  h.store.botMap.set("editor", { ...h.editor, computer: "home" });
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(h.runtime.last().spec.computerContext).toContain('named "home"');
  expect(h.runtime.last().spec.computerContext).not.toContain("slot");
  expect(h.runtime.turns()[0]?.computerSlots).toBe(
    "Computer slots on this machine: 1 slot, limited by memory",
  );
});

test("the system prompt facts are the same whatever the slot text is", async () => {
  const facts = async (slots: string) => {
    const h = makeHub(undefined, { computerSlotsText: () => slots });
    h.store.botMap.set("editor", { ...h.editor, computer: "home" });
    h.surface.deliver({ conversationId: "dc", text: "hi" });
    await flush();
    return h.runtime.last().spec.computerContext;
  };
  expect(await facts("1 slot")).toBe(await facts("3 slots, limited by cpu"));
});

test("a bot without a computer gets no computer facts", async () => {
  const h = makeHub(undefined, { computerSlotsText: () => "1 slot" });
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(h.runtime.last().spec.computerContext).toBeUndefined();
  expect(h.runtime.turns()[0]?.computerSlots).toBeUndefined();
});
