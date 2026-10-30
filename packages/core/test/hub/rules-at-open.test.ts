import { expect, test } from "bun:test";
import { CORE_DEFAULTS, type CoreLimits, type Memory, type MemoryOwner } from "../../src";
import { readRulesText } from "../../src/hub/rules-text";
import { flush, makeHub } from "../bot-hub-harness";
import { FakeLog } from "../fakes/fake-log";

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

test("readRulesText: no memory or no readRules give an empty text; a failed read gives undefined", async () => {
  const { memory, fail } = fakeRules();
  fail.add("bot:editor");
  const log = new FakeLog();
  expect(await readRulesText(memory, { kind: "bot", botId: "editor" }, log)).toBeUndefined();
  expect(await readRulesText(undefined, { kind: "bot", botId: "editor" })).toBe("");
  const bare: Memory = { read: async () => "", save: async () => {}, edit: async () => {} };
  expect(await readRulesText(bare, { kind: "bot", botId: "editor" })).toBe("");
});

test("bot and group rules go into the spec at open; a direct run never gets group rules", async () => {
  const { memory, rules } = fakeRules();
  rules.set("bot:writer", "- Be kind.");
  rules.set("bot:editor", "- Be brief.");
  rules.set("group:g", "- Team rule.");
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  expect(runtime.nth(0).spec.rules).toBe("- Be kind.");
  expect(runtime.nth(0).spec.groupRules).toBe("- Team rule.");
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(runtime.last().spec.rules).toBe("- Be brief.");
  expect(runtime.last().spec.groupRules).toBeUndefined();
});

test("a rule change reaches the next run; all rules off leaves no rules in the spec", async () => {
  const { memory, rules } = fakeRules();
  rules.set("bot:editor", "- A");
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  expect(runtime.last().spec.rules).toBe("- A");
  runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  rules.set("bot:editor", "- A\n- B");
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(runtime.last().spec.rules).toBe("- A\n- B");
  runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  rules.set("bot:editor", "");
  surface.deliver({ conversationId: "dc", text: "three" });
  await flush();
  expect(runtime.last().spec.rules).toBeUndefined();
});

test("rules survive a compaction: the next run's system prompt still has them", async () => {
  const { memory, rules } = fakeRules();
  rules.set("group:g", "- Team rule.");
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  const s = runtime.nth(0);
  s.emit({ type: "compacted" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  surface.deliver({ conversationId: "gc", text: "two" });
  await flush();
  expect(runtime.last().spec.groupRules).toBe("- Team rule.");
});

test("a failed rules read still opens the session and sends the turn", async () => {
  const { memory, fail } = fakeRules();
  fail.add("bot:editor");
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(runtime.nth(0).sent).toHaveLength(1);
  expect(runtime.nth(0).spec.rules).toBeUndefined();
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

test("an owner SOUL/USER edit reaches the next run's system prompt without a stop", async () => {
  const h = makeHub();
  const withOwner = (preface: string) =>
    h.store.botMap.set("editor", {
      ...h.editor,
      instructions: `${preface}\n\nEdit.`,
      ownerPreface: preface,
    });
  withOwner("Be warm.");
  h.surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  expect(h.runtime.last().spec.bot.instructions).toStartWith("Be warm.");
  h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  withOwner("Be terse.");
  h.surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(h.runtime.last().spec.bot.instructions).toStartWith("Be terse.");
});
