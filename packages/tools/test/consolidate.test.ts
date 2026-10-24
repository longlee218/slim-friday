import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
    skipped: 0,
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
  expect(again).toEqual({ promoted: 0, skipped: 0 });
  expect(called).toBe(false);
});

test("a duplicate note is skipped, not an error", async () => {
  const { root, mem } = setup();
  await mem.save(ann, "deploy uses docker");
  const r = await consolidateOwner(mem, ann, now, async () => [
    { kind: "fact", note: "deploy uses docker" },
  ]);
  expect(r).toEqual({ promoted: 0, skipped: 1, through: "2026-10-22" });
  expect(
    readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8").match(/deploy uses docker/g),
  ).toHaveLength(1);
});

test("an over-long picked note is skipped and counted, never stored cut", async () => {
  const { root, mem } = setup();
  const r = await consolidateOwner(mem, ann, now, async () => [
    { kind: "fact", note: `deploy ${"word ".repeat(60)}` },
  ]);
  expect(r).toEqual({ promoted: 0, skipped: 1, through: "2026-10-22" });
  expect(existsSync(join(root, "bots", "ann", "MEMORY.md"))).toBe(false);
});

test("ask returning undefined leaves the mark", async () => {
  const { root, mem } = setup();
  expect(await consolidateOwner(mem, ann, now, async () => undefined)).toEqual({
    promoted: 0,
    skipped: 0,
  });
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

test("a reworded copy of a saved note, a copy inside the batch and a too-short note are skipped and counted", async () => {
  const { root, mem } = setup();
  await mem.save(ann, "Deploy uses Docker Compose on one VPS");
  const r = await consolidateOwner(mem, ann, now, async () => [
    { kind: "fact", note: "deploy uses docker compose on one vps." },
    { kind: "preference", note: "owner prefers short answers always" },
    { kind: "preference", note: "Owner prefers short answers, always" },
    { kind: "fact", note: "ok" },
  ]);
  expect(r).toEqual({ promoted: 1, skipped: 3, through: "2026-10-22" });
  const file = readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8");
  expect(file.match(/short answers/gi)).toHaveLength(1);
  expect(file.match(/docker compose/gi)).toHaveLength(1);
  expect(readConsolidatedMark(root, ann)).toBe("2026-10-22");
});

test("a day with more notes than one batch is sent whole", async () => {
  const root = mkdtempSync(join(tmpdir(), "cons-"));
  const mem = new FileMemory(root, () => now);
  const many = Array.from({ length: 250 }, (_, i) => `note number ${i} about the deploy setup`);
  appendJournal(root, ann, "Flush", many, at("2026-10-21T09:00:00"));
  let got: string[] = [];
  const r = await consolidateOwner(mem, ann, now, async (_m, notes) => {
    got = notes;
    return [];
  });
  expect(got).toHaveLength(250);
  expect(r.through).toBe("2026-10-21");
});

test("the model sees memory as numbered notes and a pick with replaces updates that note", async () => {
  const { root, mem } = setup();
  await mem.save(ann, "owner wants answers in Vietnamese", "preference");
  await mem.save(ann, "deploy target is fly.io");
  let shown = "";
  const r = await consolidateOwner(mem, ann, now, async (m) => {
    shown = m;
    return [{ kind: "preference", note: "owner wants answers in English", replaces: 1 }];
  });
  expect(shown).toBe(
    "[1] (preference) owner wants answers in Vietnamese\n[2] (fact) deploy target is fly.io",
  );
  expect(r).toEqual({ promoted: 1, skipped: 0, through: "2026-10-22" });
  const file = readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8");
  expect(file).toContain("owner wants answers in English");
  expect(file).not.toContain("in Vietnamese");
  expect(readdirSync(join(root, "bots", "ann", "backups")).length).toBeGreaterThan(0);
});

test("at most 3 replacements a run; more, or a number out of range, are added as new notes", async () => {
  const { root, mem } = setup();
  for (const n of ["alpha one", "beta two", "gamma three", "delta four"]) await mem.save(ann, n);
  const r = await consolidateOwner(mem, ann, now, async () => [
    { kind: "fact", note: "alpha one updated", replaces: 1 },
    { kind: "fact", note: "beta two updated", replaces: 2 },
    { kind: "fact", note: "gamma three updated", replaces: 3 },
    { kind: "fact", note: "delta four updated", replaces: 4 },
    { kind: "fact", note: "epsilon five new", replaces: 9 },
  ]);
  expect(r.promoted).toBe(5);
  const file = readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8");
  expect(file).not.toContain("- alpha one (");
  expect(file).toContain("- delta four (");
  expect(file).toContain("delta four updated");
  expect(file).toContain("epsilon five new");
});
