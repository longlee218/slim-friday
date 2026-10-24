import { expect, test } from "bun:test";
import type { Conversation, Memory, MemoryOwner } from "../../src";
import { rulesForTurn } from "../../src/hub/rules-for-turn";
import type { PoolEntry } from "../../src/hub/session-pool";
import { bot, flush, makeHub } from "../bot-hub-harness";

/** A memory whose rules the test sets by owner key; a key in `fail` throws. */
function fakeRules() {
  const rules = new Map<string, string>();
  const fail = new Set<string>();
  const key = (o: MemoryOwner) => (o.kind === "bot" ? `bot:${o.botId}` : `group:${o.groupId}`);
  const memory: Memory = {
    read: async () => "",
    save: async () => {},
    edit: async () => {},
    readRules: async (o) => {
      if (fail.has(key(o))) throw new Error("disk");
      return rules.get(key(o)) ?? "";
    },
  };
  return { memory, rules, fail };
}
const entry = (shown = "") =>
  ({ bot: bot("editor", "Editor"), rulesShown: shown, groupRulesSent: new Map() }) as PoolEntry;
const direct: Conversation = { id: "dc", kind: "direct", botId: "editor" };
const group: Conversation = { id: "gc", kind: "group", groupId: "g" };

test("a rule turned off is gone from the next turn, then nothing", async () => {
  const { memory, rules } = fakeRules();
  const e = entry("- A\n- B");
  rules.set("bot:editor", "- A");
  expect(await rulesForTurn(e, direct, memory)).toEqual({ botRules: "- A" });
  expect(await rulesForTurn(e, direct, memory)).toEqual({});
});

test("all rules off sends (none) once", async () => {
  const { memory } = fakeRules();
  const e = entry("- A");
  expect(await rulesForTurn(e, direct, memory)).toEqual({ botRules: "(none)" });
  expect(await rulesForTurn(e, direct, memory)).toEqual({});
});

test("a failed read sends nothing and keeps what was shown", async () => {
  const { memory, fail, rules } = fakeRules();
  const e = entry("- A");
  fail.add("bot:editor");
  expect(await rulesForTurn(e, direct, memory)).toEqual({});
  expect(e.rulesShown).toBe("- A");
  fail.clear();
  rules.set("bot:editor", "- A");
  expect(await rulesForTurn(e, direct, memory)).toEqual({});
});

test("no memory or an adapter without readRules sends nothing", async () => {
  expect(await rulesForTurn(entry("- A"), direct, undefined)).toEqual({});
  const bare: Memory = { read: async () => "", save: async () => {}, edit: async () => {} };
  expect(await rulesForTurn(entry("- A"), direct, bare)).toEqual({});
});

test("group rules once per change; a direct turn never carries them", async () => {
  const { memory, rules } = fakeRules();
  rules.set("group:g", "- G1");
  const e = entry();
  expect(await rulesForTurn(e, direct, memory)).toEqual({});
  expect(await rulesForTurn(e, group, memory)).toEqual({ groupRules: "- G1" });
  expect(await rulesForTurn(e, group, memory)).toEqual({});
  rules.set("group:g", "");
  expect(await rulesForTurn(e, group, memory)).toEqual({ groupRules: "(none)" });
  expect(await rulesForTurn(e, group, memory)).toEqual({});
});

test("hub: rules go into the spec at open, and group rules return after a compaction", async () => {
  const { memory, rules } = fakeRules();
  rules.set("bot:writer", "- Be kind.");
  rules.set("group:g", "- Team rule.");
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  const s = runtime.nth(0);
  expect(s.spec.rules).toBe("- Be kind.");
  expect(s.sent[0]?.botRules).toBeUndefined();
  expect(s.sent[0]?.groupRules).toBe("- Team rule.");
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  surface.deliver({ conversationId: "gc", text: "two" });
  await flush();
  expect(s.sent[1]?.groupRules).toBeUndefined();
  s.emit({ type: "turn_end", costUsd: 0 });
  s.emit({ type: "compacted" } as never);
  await flush();
  surface.deliver({ conversationId: "gc", text: "three" });
  await flush();
  expect(s.sent[2]?.groupRules).toBe("- Team rule.");
});
