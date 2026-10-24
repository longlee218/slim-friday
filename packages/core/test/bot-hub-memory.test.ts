import { expect, test } from "bun:test";
import type { Memory, MemoryOwner } from "../src";
import { flush, makeHub } from "./bot-hub-harness";

/** A memory whose texts the test sets by owner key (`bot:<id>` / `group:<id>`). */
function fakeMemory() {
  const texts = new Map<string, string>();
  const key = (o: MemoryOwner) => (o.kind === "bot" ? `bot:${o.botId}` : `group:${o.groupId}`);
  const memory: Memory = {
    read: async (o) => texts.get(key(o)) ?? "",
    save: async () => {},
    edit: async () => {},
  };
  return { memory, texts };
}

test("bot memory goes into the session spec at open", async () => {
  const { memory, texts } = fakeMemory();
  texts.set("bot:editor", "## Facts\n- likes tea");
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(runtime.nth(0).spec.memory).toContain("likes tea");
});

test("group memory is sent on the first group turn and again only after it changed", async () => {
  const { memory, texts } = fakeMemory();
  texts.set("group:g", "- team uses bun");
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  const s = runtime.nth(0);
  expect(s.sent[0]?.groupMemory).toBe("- team uses bun");
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  surface.deliver({ conversationId: "gc", text: "two" });
  await flush();
  expect(s.sent[1]?.groupMemory).toBeUndefined();
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  texts.set("group:g", "- team uses bun\n- deploy friday");
  surface.deliver({ conversationId: "gc", text: "three" });
  await flush();
  expect(s.sent[2]?.groupMemory).toContain("deploy friday");
});

test("a direct turn never carries group memory; a failing read still sends the turn", async () => {
  const { memory, texts } = fakeMemory();
  texts.set("group:g", "- secret plan");
  const broken: Memory = { ...memory, read: async () => Promise.reject(new Error("disk")) };
  const a = makeHub(memory);
  a.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(a.runtime.nth(0).sent[0]?.groupMemory).toBeUndefined();
  const b = makeHub(broken);
  b.surface.deliver({ conversationId: "gc", text: "hi" });
  await flush();
  expect(b.runtime.nth(0).sent).toHaveLength(1);
  expect(b.runtime.nth(0).spec.memory).toBeUndefined();
});
