import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryOwner } from "@friday/core";
import { FileMemory } from "../src/memory/file-memory";
import { appendJournal, pruneJournals } from "../src/memory/journal";
import { chunkMemory } from "../src/memory/recall/chunk-memory";
import { Indexer } from "../src/memory/recall/indexer";
import { FakeIndexStore } from "./fake-index-store";

const ann: MemoryOwner = { kind: "bot", botId: "ann" };
const team: MemoryOwner = { kind: "group", groupId: "team" };

test("chunkMemory: one chunk per bullet, date suffix stays in text, headings skipped, ref stable", () => {
  const text = "# Ann\n\n## Facts\n- uses docker (2026-10-20)\n- likes tea (2026-10-21)\n";
  const a = chunkMemory(text, "MEMORY.md");
  expect(a.map((c) => c.text)).toEqual(["uses docker (2026-10-20)", "likes tea (2026-10-21)"]);
  expect(a[0]?.path).toBe("MEMORY.md");
  expect(chunkMemory(text, "MEMORY.md").map((c) => c.ref)).toEqual(a.map((c) => c.ref));
  expect(new Set(a.map((c) => c.ref)).size).toBe(2);
});

test("chunkMemory: a long paragraph is one chunk cut at 1200 chars, a short one is ignored, repeats collapse", () => {
  const long = "x".repeat(2000);
  const out = chunkMemory(`# T\n\nshort\n\n${long}\n\n- same\n- same\n`, "MEMORY.md", "2026-10-20");
  expect(out.map((c) => c.text.length)).toEqual([1200, 4]);
  expect(out[0]?.at).toBe("2026-10-20");
});

function seeded() {
  const root = mkdtempSync(join(tmpdir(), "indexer-"));
  const mem = new FileMemory(root);
  const store = new FakeIndexStore();
  return { root, mem, store, indexer: new Indexer(root, store) };
}

test("reindexOwner indexes MEMORY.md as doc 'memory' and each journal day as 'journal/<day>'", async () => {
  const { root, mem, store, indexer } = seeded();
  await mem.save(ann, "deploy uses docker compose");
  appendJournal(root, ann, "Flush", ["docker image is slim"], new Date("2026-10-20T09:00:00"));
  expect(indexer.reindexOwner(ann)).toBe(2);
  expect(store.docIds(ann).sort()).toEqual(["journal/2026-10-20", "memory"]);
  const journal = store.searchText(ann, "slim", 5)[0];
  expect(journal).toMatchObject({ docId: "journal/2026-10-20", at: "2026-10-20" });
  expect(journal?.path).toBe("journal/2026-10-20.md");
});

test("an unchanged file is not written again", async () => {
  const { mem, store, indexer } = seeded();
  await mem.save(ann, "alpha note");
  indexer.reindexOwner(ann);
  expect(indexer.reindexOwner(ann)).toBe(0);
  expect(store.upserts).toBe(1);
});

test("a changed file replaces its chunks; a deleted or pruned journal file removes its doc", async () => {
  const { root, mem, store, indexer } = seeded();
  await mem.save(ann, "alpha note");
  appendJournal(root, ann, "Flush", ["old journal note"], new Date("2026-01-01T09:00:00"));
  indexer.reindexOwner(ann);
  await mem.save(ann, "beta note");
  expect(indexer.reindexOwner(ann)).toBe(1);
  expect(store.searchText(ann, "beta", 5)).toHaveLength(1);
  pruneJournals(root, new Date("2026-10-24T00:00:00"));
  expect(indexer.reindexOwner(ann)).toBe(1);
  expect(store.docIds(ann)).toEqual(["memory"]);
  rmSync(join(root, "bots", "ann", "MEMORY.md"));
  indexer.reindexOwner(ann);
  expect(store.docIds(ann)).toEqual([]);
});

test("reconcileAll covers bots and groups and ignores a dir with a bad id", async () => {
  const { root, mem, store, indexer } = seeded();
  await mem.save(ann, "bot note");
  await mem.save(team, "group note");
  for (const bad of ["A B", "x..y"]) {
    mkdirSync(join(root, "bots", bad), { recursive: true });
    writeFileSync(join(root, "bots", bad, "MEMORY.md"), "- evil note\n");
  }
  expect(indexer.reconcileAll()).toBe(2);
  expect(store.docIds(ann)).toEqual(["memory"]);
  expect(store.docIds(team)).toEqual(["memory"]);
  expect(store.docs.size).toBe(2);
});

test("5000 bullets index in one pass and the second pass writes nothing", async () => {
  const { root, store, indexer } = seeded();
  mkdirSync(join(root, "bots", "ann"), { recursive: true });
  const lines = Array.from({ length: 5000 }, (_, i) => `- note number ${i} (2026-10-20)`);
  writeFileSync(join(root, "bots", "ann", "MEMORY.md"), `## Facts\n${lines.join("\n")}\n`);
  expect(indexer.reindexOwner(ann)).toBe(1);
  expect(store.docs.get("bot:ann|memory")?.chunks).toHaveLength(5000);
  expect(indexer.reindexOwner(ann)).toBe(0);
});
