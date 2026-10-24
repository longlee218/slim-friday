import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryOwner } from "@friday/core";
import { openMemoryIndex } from "../src/memory-index";

const ann: MemoryOwner = { kind: "bot", botId: "ann" };
const bob: MemoryOwner = { kind: "bot", botId: "bob" };
const team: MemoryOwner = { kind: "group", groupId: "team" };
const chunk = (ref: string, text: string, path = "MEMORY.md") => ({ ref, path, text });
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "mem-index-")), "sub", "memory-index.db");

test("upsertDoc then searchText finds the chunk with its ref, path and docId", () => {
  const idx = openMemoryIndex(":memory:");
  idx.upsertDoc(ann, "memory", "h1", [chunk("a1", "deploy uses docker compose")]);
  const [hit] = idx.searchText(ann, "docker", 5);
  expect(hit).toMatchObject({
    ref: "a1",
    path: "MEMORY.md",
    docId: "memory",
    text: "deploy uses docker compose",
  });
  expect(hit?.score).toBeGreaterThan(0);
});

test("bm25: the chunk holding more query words ranks first; limit caps the list", () => {
  const idx = openMemoryIndex(":memory:");
  idx.upsertDoc(ann, "memory", "h", [
    chunk("a", "owner likes docker"),
    chunk("b", "deploy uses docker compose"),
    chunk("c", "unrelated tea"),
  ]);
  expect(idx.searchText(ann, "docker compose", 5).map((h) => h.ref)).toEqual(["b", "a"]);
  expect(idx.searchText(ann, "docker compose", 1)).toHaveLength(1);
});

test("owners are isolated: a bot query never returns a group's or another bot's chunk", () => {
  const idx = openMemoryIndex(":memory:");
  idx.upsertDoc(ann, "memory", "h", [chunk("a", "secret docker")]);
  idx.upsertDoc(bob, "memory", "h", [chunk("b", "bob docker")]);
  idx.upsertDoc(team, "memory", "h", [chunk("g", "group docker")]);
  expect(idx.searchText(ann, "docker", 10).map((h) => h.ref)).toEqual(["a"]);
  expect(idx.searchText(team, "docker", 10).map((h) => h.ref)).toEqual(["g"]);
  expect(idx.docIds(bob)).toEqual(["memory"]);
});

test("folds diacritics and đ: 'trien khai' finds 'triển khai', 'da xong' finds 'ĐÃ xong'", () => {
  const idx = openMemoryIndex(":memory:");
  idx.upsertDoc(ann, "memory", "h", [
    chunk("a", "triển khai bằng docker"),
    chunk("b", "ĐÃ xong việc"),
    chunk("c", "Tiếng Việt có dấu"),
  ]);
  expect(idx.searchText(ann, "trien khai", 5).map((h) => h.ref)).toEqual(["a"]);
  expect(idx.searchText(ann, "da xong", 5).map((h) => h.ref)).toEqual(["b"]);
  expect(idx.searchText(ann, "VIET", 5).map((h) => h.ref)).toEqual(["c"]);
  expect(idx.searchText(ann, "đã", 5).map((h) => h.ref)).toEqual(["b"]);
});

test("hostile queries never throw", () => {
  const idx = openMemoryIndex(":memory:");
  idx.upsertDoc(ann, "memory", "h", [chunk("a", "docker compose")]);
  for (const q of ['"', "a*", "-x", "a:b", "a AND", "NEAR(", "(", "", "docker AND (", "\\"])
    expect(Array.isArray(idx.searchText(ann, q, 5))).toBe(true);
  expect(idx.searchText(ann, "docker AND (", 5)).toHaveLength(1);
});

test("upsertDoc replaces the old chunks of that doc; removeDoc deletes them; docIds and docHash follow", () => {
  const idx = openMemoryIndex(":memory:");
  idx.upsertDoc(ann, "memory", "h1", [chunk("a", "alpha"), chunk("b", "beta")]);
  idx.upsertDoc(ann, "journal/2026-10-20", "j1", [chunk("c", "gamma", "journal/2026-10-20.md")]);
  idx.upsertDoc(ann, "memory", "h2", [chunk("d", "delta")]);
  expect(idx.docHash(ann, "memory")).toBe("h2");
  expect(idx.searchText(ann, "alpha", 5)).toEqual([]);
  expect(idx.searchText(ann, "delta", 5)).toHaveLength(1);
  expect(idx.docIds(ann).sort()).toEqual(["journal/2026-10-20", "memory"]);
  idx.removeDoc(ann, "journal/2026-10-20");
  expect(idx.searchText(ann, "gamma", 5)).toEqual([]);
  expect(idx.docHash(ann, "journal/2026-10-20")).toBeUndefined();
});

test("a db with another user_version is dropped and rebuilt empty", () => {
  const f = tmpFile();
  const a = openMemoryIndex(f);
  a.upsertDoc(ann, "memory", "h", [chunk("a", "alpha")]);
  a.close();
  const raw = new Database(f);
  raw.run("PRAGMA user_version = 99");
  raw.close();
  const b = openMemoryIndex(f);
  expect(b.docIds(ann)).toEqual([]);
  b.upsertDoc(ann, "memory", "h", [chunk("a", "alpha")]);
  expect(b.searchText(ann, "alpha", 5)).toHaveLength(1);
  b.close();
});

test("a corrupt file is replaced by an empty index", () => {
  const f = tmpFile();
  openMemoryIndex(f).close();
  writeFileSync(f, "this is not a sqlite file at all".repeat(50));
  const idx = openMemoryIndex(f);
  expect(idx.docIds(ann)).toEqual([]);
  idx.close();
});

test("the db file and its sidecars are owner-only", () => {
  const f = tmpFile();
  const idx = openMemoryIndex(f);
  idx.upsertDoc(ann, "memory", "h", [chunk("a", "alpha")]);
  expect(statSync(f).mode & 0o777).toBe(0o600);
  idx.close();
});
