import { expect, test } from "bun:test";
import {
  CORE_DEFAULTS,
  type CoreLimits,
  EMPTY_MEMORY_NOTE,
  type Memory,
  type MemoryOwner,
  type MemorySearcher,
} from "../src";
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

test("after a compaction the group memory is sent again", async () => {
  const { memory, texts } = fakeMemory();
  texts.set("group:g", "- team uses bun");
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  const s = runtime.nth(0);
  s.emit({ type: "compacted" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  surface.deliver({ conversationId: "gc", text: "two" });
  await flush();
  expect(s.sent[1]?.groupMemory).toBe("- team uses bun");
});

test("a background task started in another conversation cannot use group scope while the bot answers a group", async () => {
  const { memory } = fakeMemory();
  const { runtime, surface, store } = makeHub(memory);
  // A second chat of the same group shares the bot's group session.
  store.convMap.set("gc2", { id: "gc2", kind: "group", groupId: "g" });
  // The owner would allow anything: only the scope rule may deny.
  surface.answerWith("once");
  surface.deliver({ conversationId: "gc2", text: "@Editor start a task" });
  await flush();
  const s = runtime.nth(0);
  s.emit({ type: "task_started", taskId: "t1", description: "dig" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  surface.deliver({ conversationId: "gc", text: "@Editor hello group" });
  await flush();
  const d = await Promise.race([
    s.spec.decide({ tool: "mcp__memory__MemorySave", input: { scope: "group" }, taskId: "t1" }),
    Bun.sleep(300).then(() => "timeout"),
  ]);
  expect(d).toMatchObject({ behavior: "deny" });
  const own = await s.spec.decide({
    tool: "mcp__memory__MemorySave",
    input: { scope: "bot" },
    taskId: "t1",
  });
  expect(own).toEqual({ behavior: "allow" });
});

test("a group turn recalls only the group's notes; a direct turn recalls the bot's", async () => {
  const { memory } = fakeMemory();
  const asked: string[] = [];
  const recall: MemorySearcher = {
    search: async (o) => {
      asked.push(o.kind === "bot" ? `bot:${o.botId}` : `group:${o.groupId}`);
      return [
        { source: "builtin", where: "2026-10-20", ref: "r", text: `from ${o.kind}`, score: 1 },
      ];
    },
  };
  const { runtime, surface } = makeHub(memory, { recall });
  surface.deliver({ conversationId: "gc", text: "what did we decide" });
  await flush();
  expect(asked).toEqual(["group:g"]);
  expect(runtime.nth(0).sent[0]?.recalled).toContain("- [2026-10-20] from group");
  expect(runtime.nth(0).sent[0]?.recalled).not.toContain("from bot");
  surface.deliver({ conversationId: "dc", text: "what did we decide" });
  await flush();
  expect(asked.slice(1)).toEqual(["bot:editor"]);
});

test("a group session gets only the preferences and lessons of the bot's memory; a direct one gets all", async () => {
  const kindsAsked: (string | undefined)[] = [];
  const memory: Memory = {
    read: async () => "whole",
    readForPrompt: async (_o, _max, kinds) => {
      kindsAsked.push(kinds?.join(","));
      return { text: `memory for ${kinds?.join(",") ?? "all"}`, hidden: 0, chars: 5 };
    },
    save: async () => {},
    edit: async () => {},
  };
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  surface.deliver({ conversationId: "gc", text: "@editor hi" });
  await flush();
  const direct = runtime.all().find((s) => !s.spec.groupId);
  const group = runtime.all().find((s) => s.spec.groupId === "g");
  expect(direct?.spec.memory).toBe("memory for all");
  expect(group?.spec.memory).toBe("memory for preference,lesson");
});

test("without readForPrompt a group session gets none of the bot's memory", async () => {
  const { memory, texts } = fakeMemory();
  texts.set("bot:writer", "## Facts\n- private fact");
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "gc", text: "hi" });
  await flush();
  expect(runtime.nth(0).spec.memory).toBeUndefined();
});

/** A memory whose readForPrompt cuts to the cap and reports the file size. */
function cappedMemory(text: string) {
  const caps: number[] = [];
  const memory: Memory = {
    read: async () => text,
    readForPrompt: async (_o, max) => {
      caps.push(max);
      return { text: text.slice(0, max), hidden: text.length > max ? 1 : 0, chars: text.length };
    },
    save: async () => {},
    edit: async () => {},
  };
  return { memory, caps };
}

test("the session spec gets the capped memory and a memory.large warning when the file is over twice the cap", async () => {
  const { memory } = cappedMemory(`- ${"a".repeat(100)}`);
  const limits: CoreLimits = {
    ...CORE_DEFAULTS,
    memoryPromptChars: 20,
    groupMemoryPromptChars: 20,
  } as unknown as CoreLimits;
  const { runtime, surface, log } = makeHub(memory, { limits });
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(runtime.nth(0).spec.memory).toBe(`- ${"a".repeat(18)}`);
  expect(log.of("memory.large")[0]?.level).toBe("warn");
});

test("group memory on a turn is capped at groupMemoryPromptChars", async () => {
  const { memory, caps } = cappedMemory("- team uses bun and deploys on friday");
  const limits: CoreLimits = {
    ...CORE_DEFAULTS,
    groupMemoryPromptChars: 10,
  } as unknown as CoreLimits;
  const { runtime, surface } = makeHub(memory, { limits });
  surface.deliver({ conversationId: "gc", text: "hello" });
  await flush();
  expect(caps).toContain(10);
  expect(runtime.nth(0).sent[0]?.groupMemory).toBe("- team use");
});

test("a group turn whose send fails sends the group memory again on the next turn", async () => {
  const { memory, texts } = fakeMemory();
  texts.set("group:g", "- team uses bun");
  const { runtime, surface } = makeHub(memory);
  let failOnce = true;
  runtime.onTurn = () => {
    if (failOnce) {
      failOnce = false;
      throw new Error("unreadable attachment");
    }
  };
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  surface.deliver({ conversationId: "gc", text: "two" });
  await flush();
  const s = runtime.nth(0);
  expect(s.sent[1]?.groupMemory).toBe("- team uses bun");
});

test("after a compaction the bot's changed MEMORY.md goes with the next turn, once", async () => {
  const { memory, texts } = fakeMemory();
  texts.set("bot:editor", "## Facts\n- likes tea");
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  const s = runtime.nth(0);
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  // A compaction with the file unchanged sends nothing.
  s.emit({ type: "compacted" });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(s.sent[1]?.botMemory).toBeUndefined();
  s.emit({ type: "turn_end", costUsd: 0 });
  texts.set("bot:editor", "## Facts\n- likes tea\n- answers in Vietnamese");
  s.emit({ type: "compacted" });
  await flush();
  surface.deliver({ conversationId: "dc", text: "three" });
  await flush();
  expect(s.sent[2]?.botMemory).toContain("answers in Vietnamese");
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  surface.deliver({ conversationId: "dc", text: "four" });
  await flush();
  expect(s.sent[3]?.botMemory).toBeUndefined();
});

test("a turn after a compaction whose send fails sends the updated memory again on the next turn", async () => {
  const { memory, texts } = fakeMemory();
  texts.set("bot:editor", "## Facts\n- likes tea");
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  const s = runtime.nth(0);
  s.emit({ type: "turn_end", costUsd: 0 });
  texts.set("bot:editor", "## Facts\n- likes tea\n- answers in Vietnamese");
  s.emit({ type: "compacted" });
  await flush();
  let failOnce = true;
  s.onSend = () => {
    if (failOnce) {
      failOnce = false;
      throw new Error("unreadable attachment");
    }
  };
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  surface.deliver({ conversationId: "dc", text: "three" });
  await flush();
  expect(s.sent[2]?.botMemory).toContain("answers in Vietnamese");
});

test("after a compaction a memory emptied by the owner is reported as empty", async () => {
  const { memory, texts } = fakeMemory();
  texts.set("bot:editor", "## Facts\n- likes tea");
  const { runtime, surface } = makeHub(memory);
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  const s = runtime.nth(0);
  s.emit({ type: "turn_end", costUsd: 0 });
  texts.set("bot:editor", "");
  s.emit({ type: "compacted" });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(s.sent[1]?.botMemory).toBe(EMPTY_MEMORY_NOTE);
});

test("after a compaction a failed memory read is not reported as an emptied memory", async () => {
  const { memory, texts } = fakeMemory();
  texts.set("bot:editor", "## Facts\n- likes tea");
  let broken = false;
  const flaky: Memory = {
    ...memory,
    read: async (o) => (broken ? Promise.reject(new Error("disk")) : memory.read(o)),
  };
  const { runtime, surface } = makeHub(flaky);
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  const s = runtime.nth(0);
  s.emit({ type: "turn_end", costUsd: 0 });
  broken = true;
  s.emit({ type: "compacted" });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(s.sent[1]?.botMemory).toBeUndefined();
});
