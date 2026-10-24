import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsolidateFn, MemoryOwner } from "@friday/core";
import { consolidateAll, consolidateOwner } from "../src/memory/consolidate";
import { FileMemory } from "../src/memory/file-memory";
import { appendJournal, readConsolidatedMark } from "../src/memory/journal";

const ann: MemoryOwner = { kind: "bot", botId: "ann" };
const at = (s: string) => new Date(s);
const now = at("2026-10-24T12:00:00");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "cons-"));
  const mem = new FileMemory(root, () => now);
  appendJournal(
    root,
    ann,
    "Flush",
    ["deploy uses docker", "tmp: build was red"],
    at("2026-10-20T09:00:00"),
  );
  appendJournal(root, ann, "Flush", ["owner prefers short answers"], at("2026-10-22T09:00:00"));
  appendJournal(root, ann, "Flush", ["today note"], at("2026-10-24T09:00:00"));
  return { root, mem };
}

test("promotes notes into MEMORY.md under their kind and moves the mark to the last complete day", async () => {
  const { root, mem } = setup();
  const seen: string[][] = [];
  const ask: ConsolidateFn = async (_m, notes) => {
    seen.push(notes);
    return [
      { kind: "fact", note: "deploy uses docker" },
      { kind: "preference", note: "owner prefers short answers" },
    ];
  };
  expect(await consolidateOwner(mem, ann, now, ask)).toEqual({
    promoted: 2,
    through: "2026-10-22",
  });
  expect(seen[0]).toEqual([
    "deploy uses docker",
    "tmp: build was red",
    "owner prefers short answers",
  ]);
  const file = readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8");
  expect(file).toContain("## Facts\n- deploy uses docker");
  expect(file).toContain("owner prefers short answers");
  expect(readConsolidatedMark(root, ann)).toBe("2026-10-22");
});

test("today's journal is not consolidated and no new days means no call", async () => {
  const { mem } = setup();
  await consolidateOwner(mem, ann, now, async () => []);
  let called = false;
  const again = await consolidateOwner(mem, ann, now, async () => {
    called = true;
    return [];
  });
  expect(again).toEqual({ promoted: 0 });
  expect(called).toBe(false);
});

test("a duplicate note is skipped, not an error", async () => {
  const { root, mem } = setup();
  await mem.save(ann, "deploy uses docker");
  const r = await consolidateOwner(mem, ann, now, async () => [
    { kind: "fact", note: "deploy uses docker" },
  ]);
  expect(r).toEqual({ promoted: 0, through: "2026-10-22" });
  expect(
    readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8").match(/deploy uses docker/g),
  ).toHaveLength(1);
});

test("ask returning undefined leaves the mark", async () => {
  const { root, mem } = setup();
  expect(await consolidateOwner(mem, ann, now, async () => undefined)).toEqual({ promoted: 0 });
  expect(readConsolidatedMark(root, ann)).toBeUndefined();
  expect(existsSync(join(root, "bots", "ann", "MEMORY.md"))).toBe(false);
});

test("consolidateAll covers bots and groups with valid ids", async () => {
  const { root, mem } = setup();
  appendJournal(
    root,
    { kind: "group", groupId: "team" },
    "Flush",
    ["team uses bun"],
    at("2026-10-21T09:00:00"),
  );
  const n = await consolidateAll(mem, now, async (_m, notes) =>
    notes.map((note) => ({ kind: "fact" as const, note })),
  );
  expect(n).toBe(4);
  expect(readConsolidatedMark(root, { kind: "group", groupId: "team" })).toBe("2026-10-21");
});

test("an abort stops consolidateAll: a pending ask is given up and no mark moves", async () => {
  const { root, mem } = setup();
  const ac = new AbortController();
  let asked = 0;
  const run = consolidateAll(
    mem,
    now,
    () => {
      asked++;
      ac.abort();
      return new Promise(() => {});
    },
    ac.signal,
  );
  expect(await run).toBe(0);
  expect(asked).toBe(1);
  expect(readConsolidatedMark(root, ann)).toBeUndefined();
});
