import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, Group } from "@friday/core";
import { FileMemory } from "../src/memory/file-memory";
import { appendJournal } from "../src/memory/journal";
import type { ToolSessionContext } from "../src/memory/memory-owner";
import { searchMemory } from "../src/memory/search-memory";
import { createMemorySearchTool } from "../src/memory/tools/MemorySearchTool/memory-search-tool";

const bot = { kind: "bot", botId: "ann" } as const;
const team: Group = { id: "team", name: "T", members: ["ann"], entryBot: "ann" };

async function seeded() {
  const root = mkdtempSync(join(tmpdir(), "ms-"));
  const mem = new FileMemory(root);
  await mem.save(bot, "deploy uses docker compose");
  await mem.save(bot, "owner likes tea");
  appendJournal(root, bot, "Flush", ["docker image is slim"], new Date("2026-10-20T09:00:00"));
  appendJournal(root, bot, "Flush", ["compose file moved"], new Date("2026-10-22T09:00:00"));
  appendJournal(
    root,
    { kind: "group", groupId: "team" },
    "Flush",
    ["group docker secret"],
    new Date(),
  );
  return { root, mem };
}

test("finds words in MEMORY.md and the journal, with their source", async () => {
  const { root } = await seeded();
  const hits = searchMemory(root, bot, "docker");
  expect(hits.map((h) => h.source)).toEqual(["memory", "2026-10-20"]);
  expect(hits[0]?.line).toContain("docker compose");
});

test("more query words rank higher; limit caps the list", async () => {
  const { root } = await seeded();
  const hits = searchMemory(root, bot, "docker compose");
  expect(hits[0]?.line).toContain("deploy uses docker compose");
  expect(searchMemory(root, bot, "docker compose", 1)).toHaveLength(1);
});

test("a bot search never sees a group's journal", async () => {
  const { root } = await seeded();
  expect(searchMemory(root, bot, "secret")).toEqual([]);
});

test("the tool keeps the scope rules and refuses a one-char query", async () => {
  const { mem } = await seeded();
  const dm: Conversation = { id: "dm", kind: "direct", botId: "ann" };
  const ctx: ToolSessionContext = {
    botId: "ann",
    conversation: async () => dm,
    group: async () => team,
  };
  const t = createMemorySearchTool(mem, ctx);
  const run = (a: object) =>
    t.handler(a as never, {}) as Promise<{ content: { text: string }[]; isError?: boolean }>;
  const r = await run({ query: "docker", scope: "group" });
  expect(r.isError).toBe(true);
  expect((await run({ query: "docker" })).content[0]?.text).toContain("[memory]");
  expect(t.inputSchema.query.safeParse("d").success).toBe(false);
});
