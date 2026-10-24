import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexedMessage } from "@friday/core";
import { openMemoryIndex } from "../src/memory-index";

const m = (id: number, conversationId: string, text: string): IndexedMessage => ({
  id,
  conversationId,
  author: id % 2 ? { kind: "user" } : { kind: "bot", botId: "ann" },
  text,
  at: 1_000 * id,
});

test("addMessages then searchMessages finds by words, folding diacritics", () => {
  const idx = openMemoryIndex(":memory:");
  idx.addMessages([m(1, "c1", "Triển khai bằng docker compose"), m(2, "c1", "ok cảm ơn")]);
  const hits = idx.searchMessages(["c1"], "trien khai docker", 5);
  expect(hits.map((h) => h.id)).toEqual([1]);
  expect(hits[0]).toMatchObject({ conversationId: "c1", author: { kind: "user" }, at: 1000 });
  expect(hits[0]?.score).toBeGreaterThan(0);
  expect(idx.searchMessages(["c1"], "cam on", 5).map((h) => h.author)).toEqual([
    { kind: "bot", botId: "ann" },
  ]);
});

test("searchMessages only looks inside the given conversations; no ids gives []", () => {
  const idx = openMemoryIndex(":memory:");
  idx.addMessages([m(1, "c1", "docker here"), m(2, "c2", "docker there"), m(3, "c3", "docker x")]);
  expect(
    idx
      .searchMessages(["c1", "c3"], "docker", 10)
      .map((h) => h.id)
      .sort(),
  ).toEqual([1, 3]);
  expect(idx.searchMessages([], "docker", 10)).toEqual([]);
});

test("addMessages twice with the same ids indexes once; lastMessageId is the max", () => {
  const idx = openMemoryIndex(":memory:");
  expect(idx.lastMessageId()).toBe(0);
  idx.addMessages([m(1, "c1", "alpha"), m(5, "c1", "beta")]);
  idx.addMessages([m(1, "c1", "alpha"), m(5, "c1", "beta")]);
  expect(idx.lastMessageId()).toBe(5);
  expect(idx.searchMessages(["c1"], "alpha", 10)).toHaveLength(1);
});

test("hostile message queries never throw", () => {
  const idx = openMemoryIndex(":memory:");
  idx.addMessages([m(1, "c1", "docker compose")]);
  for (const q of ['"', "a*", "-x", "a:b", "a AND", "NEAR(", "(", "", "\\"])
    expect(Array.isArray(idx.searchMessages(["c1"], q, 5))).toBe(true);
});

test("a version-1 index db is rebuilt with the messages table", () => {
  const f = join(mkdtempSync(join(tmpdir(), "msg-index-")), "memory-index.db");
  const raw = new Database(f, { create: true });
  raw.run("CREATE TABLE docs (owner TEXT, doc_id TEXT, hash TEXT)");
  raw.run("PRAGMA user_version = 1");
  raw.close();
  const idx = openMemoryIndex(f);
  idx.addMessages([m(1, "c1", "alpha")]);
  expect(idx.searchMessages(["c1"], "alpha", 5)).toHaveLength(1);
  idx.close();
});
