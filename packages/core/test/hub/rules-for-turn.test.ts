import { expect, test } from "bun:test";
import {
  CORE_DEFAULTS,
  type Conversation,
  type CoreLimits,
  type Memory,
  type MemoryOwner,
} from "../../src";
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

/** Drive a group chat: one session, the turn texts the test sets, `turn(text)` sends and ends one turn. */
async function groupSession(rules: ReturnType<typeof fakeRules>) {
  const h = makeHub(rules.memory);
  let n = 0;
  const turn = async () => {
    h.surface.deliver({ conversationId: "gc", text: `t${n++}` });
    await flush();
    const s = h.runtime.nth(0);
    return s;
  };
  return { ...h, turn };
}

test("compaction: the next turn re-sends the bot rules when they differ from the system prompt", async () => {
  const r = fakeRules();
  r.rules.set("bot:editor", "- A");
  const h = makeHub(r.memory);
  h.surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  const s = h.runtime.nth(0);
  expect(s.spec.rules).toBe("- A");
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  r.rules.set("bot:editor", "- A\n- B");
  h.surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(s.sent[1]?.botRules).toBe("- A\n- B");
  s.emit({ type: "turn_end", costUsd: 0 });
  s.emit({ type: "compacted" } as never);
  await flush();
  h.surface.deliver({ conversationId: "dc", text: "three" });
  await flush();
  expect(s.sent[2]?.botRules).toBe("- A\n- B");
});

test("compaction: every rule off now sends (none)", async () => {
  const r = fakeRules();
  r.rules.set("bot:editor", "- A");
  const h = makeHub(r.memory);
  h.surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  const s = h.runtime.nth(0);
  s.emit({ type: "turn_end", costUsd: 0 });
  r.rules.set("bot:editor", "");
  s.emit({ type: "compacted" } as never);
  await flush();
  h.surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(s.sent[1]?.botRules).toBe("(none)");
});

test("a failed send keeps the earlier group rules, so (none) still follows", async () => {
  const r = fakeRules();
  r.rules.set("group:g", "- G");
  const h = await groupSession(r);
  const s = await h.turn();
  expect(s.sent[0]?.groupRules).toBe("- G");
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  r.rules.set("group:g", "");
  const real = s.send.bind(s);
  s.send = () => {
    throw new Error("disk full");
  };
  await h.turn();
  s.send = real;
  await h.turn();
  expect(s.sent.at(-1)?.groupRules).toBe("(none)");
});

test("compaction: group rules shown, then all turned off, send (none); never shown stays silent", async () => {
  const r = fakeRules();
  r.rules.set("group:g", "- G");
  const h = await groupSession(r);
  const s = await h.turn();
  s.emit({ type: "turn_end", costUsd: 0 });
  r.rules.set("group:g", "");
  s.emit({ type: "compacted" } as never);
  await flush();
  await h.turn();
  expect(s.sent[1]?.groupRules).toBe("(none)");
  const e = entry();
  e.groupRulesSent.set("g", "\u0000compacted");
  expect(await rulesForTurn(e, direct, r.memory)).toEqual({});
  expect(await rulesForTurn(entry(), group, r.memory)).toEqual({});
});

test("rules are whole in the spec; memory is cut by its own cap only", async () => {
  const rulesText = Array.from({ length: 50 }, (_, i) => `- r${i} ${"x".repeat(90)}`).join("\n");
  const memory: Memory = {
    read: async () => "m".repeat(12_000),
    save: async () => {},
    edit: async () => {},
    readForPrompt: async (_o, max) => ({
      text: "m".repeat(12_000).slice(0, max),
      hidden: 0,
      chars: 12_000,
    }),
    readRules: async () => rulesText,
  };
  const limits = { ...CORE_DEFAULTS, memoryPromptChars: 10_000 } as unknown as CoreLimits;
  const h = makeHub(memory, { limits });
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const spec = h.runtime.nth(0).spec;
  expect(rulesText.length).toBeGreaterThan(4500);
  expect(spec.rules).toBe(rulesText);
  expect(spec.memory?.length).toBe(10_000);
});
