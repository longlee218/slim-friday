import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, Group, MemoryOwner } from "@friday/core";
import { FileMemory } from "../src/memory/file-memory";
import { appendJournal } from "../src/memory/journal";
import type { ToolSessionContext } from "../src/memory/memory-owner";
import { builtinSource } from "../src/memory/recall/builtin-source";
import { Indexer } from "../src/memory/recall/indexer";
import { MemoryRecall } from "../src/memory/recall/memory-recall";
import { createMemorySearchTool } from "../src/memory/tools/MemorySearchTool/memory-search-tool";
import { FakeIndexStore } from "./fake-index-store";

const bot = { kind: "bot", botId: "ann" } as const;
const team: Group = {
  id: "team",
  name: "T",
  members: ["ann"],
  entryBot: "ann",
  workspaces: [],
  instructions: "",
};
const dm: Conversation = { id: "dm", kind: "direct", botId: "ann" };
const ctx: ToolSessionContext = {
  botId: "ann",
  conversation: async () => dm,
  group: async () => team,
};

/** Memory files under a temp root, an index kept in step with every save and edit, and a recall over it. */
function setup(onChange?: (o: MemoryOwner) => void) {
  const root = mkdtempSync(join(tmpdir(), "ms-"));
  const store = new FakeIndexStore();
  const indexer = new Indexer(root, store);
  const mem = new FileMemory(
    root,
    () => new Date(),
    (o) => {
      indexer.reindexOwner(o);
      onChange?.(o);
    },
  );
  return { root, mem, indexer, recall: new MemoryRecall([builtinSource(store)]) };
}
type Result = { content: { text: string }[]; isError?: boolean };
const run = (t: ReturnType<typeof createMemorySearchTool>, a: object) =>
  t.handler(a as never, {}) as Promise<Result>;

async function seeded() {
  const s = setup();
  await s.mem.save(bot, "deploy uses docker compose");
  await s.mem.save(bot, "owner likes tea");
  appendJournal(s.root, bot, "Flush", ["docker image is slim"], new Date("2026-10-20T09:00:00"));
  appendJournal(s.root, bot, "Flush", ["compose file moved"], new Date("2026-10-22T09:00:00"));
  appendJournal(
    s.root,
    { kind: "group", groupId: "team" },
    "Flush",
    ["group docker secret"],
    new Date(),
  );
  s.indexer.reconcileAll();
  return s;
}

test("finds words in MEMORY.md and the journal, with their source", async () => {
  const { recall } = await seeded();
  const hits = await recall.search(bot, "docker");
  expect(hits.map((h) => h.where).sort()).toEqual(["2026-10-20", "memory"]);
  expect(hits.find((h) => h.where === "memory")?.text).toContain("docker compose");
});

test("more query words rank higher; limit caps the list", async () => {
  const { recall } = await seeded();
  const hits = await recall.search(bot, "docker compose");
  expect(hits[0]?.text).toContain("deploy uses docker compose");
  expect(await recall.search(bot, "docker compose", 1)).toHaveLength(1);
});

test("a bot search never sees a group's journal", async () => {
  const { recall } = await seeded();
  expect(await recall.search(bot, "secret")).toEqual([]);
});

test("the tool keeps the scope rules and refuses a one-char query", async () => {
  const { recall } = await seeded();
  const t = createMemorySearchTool(recall, ctx);
  const r = await run(t, { query: "docker", scope: "group" });
  expect(r.isError).toBe(true);
  expect((await run(t, { query: "docker" })).content[0]?.text).toContain("[memory]");
  expect(t.inputSchema.query.safeParse("d").success).toBe(false);
});

test("a note saved through FileMemory is found at once", async () => {
  const { mem, recall } = setup();
  await mem.save(bot, "backups run nightly");
  const t = createMemorySearchTool(recall, ctx);
  expect((await run(t, { query: "nightly" })).content[0]?.text).toContain("backups run nightly");
});

test("an edit that deletes a note removes it from search", async () => {
  const { mem, recall } = setup();
  await mem.save(bot, "backups run nightly");
  const id = mem.listBullets(bot)[0]?.id ?? "";
  await mem.edit(bot, id, null);
  const t = createMemorySearchTool(recall, ctx);
  expect((await run(t, { query: "nightly" })).content[0]?.text).toBe("no match");
});

test("onChange that throws does not fail the save", async () => {
  const root = mkdtempSync(join(tmpdir(), "ms-"));
  const mem = new FileMemory(
    root,
    () => new Date(),
    () => {
      throw new Error("index down");
    },
  );
  await mem.save(bot, "still saved");
  expect(mem.listBullets(bot)).toHaveLength(1);
});

test("MemorySearch returns no match (not an error) for a query of only punctuation", async () => {
  const { recall } = await seeded();
  const r = await run(createMemorySearchTool(recall, ctx), { query: '""' });
  expect(r.isError).toBeUndefined();
  expect(r.content[0]?.text).toBe("no match");
});

test("in a group session a bot-scope search shows only preference and lesson notes", async () => {
  const s = setup();
  await s.mem.save(bot, "owner wants docker answers short", "preference");
  await s.mem.save(bot, "private docker registry password is in vault");
  appendJournal(s.root, bot, "Flush", ["docker journal line"], new Date("2026-10-20T09:00:00"));
  s.indexer.reconcileAll();
  const groupCtx: ToolSessionContext = { ...ctx, groupId: "team" };
  const text = (await run(createMemorySearchTool(s.recall, groupCtx, s.mem), { query: "docker" }))
    .content[0]?.text;
  expect(text).toContain("owner wants docker answers short");
  expect(text).not.toContain("registry");
  expect(text).not.toContain("journal line");
});
