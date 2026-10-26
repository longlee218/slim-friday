import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsolidateFn, MemoryOwner } from "@friday/core";
import { consolidateAll, consolidateOwner } from "../src/memory/consolidate";
import { FileMemory } from "../src/memory/file-memory";
import {
  appendJournal,
  groupLabel,
  readConsolidatedMark,
  writeConsolidatedMark,
} from "../src/memory/journal";

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

test("promotes notes into MEMORY.md under their kind and moves the mark past the last note sent", async () => {
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
    through: "2026-10-24#1",
  });
  expect(seen[0]).toEqual([
    "deploy uses docker",
    "tmp: build was red",
    "owner prefers short answers",
    "today note",
  ]);
  const file = readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8");
  expect(file).toContain("## Facts\n- deploy uses docker");
  expect(file).toContain("owner prefers short answers");
  expect(readConsolidatedMark(root, ann)).toEqual({ day: "2026-10-24", count: 1 });
});

test("nothing new makes no call", async () => {
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
  expect(r).toEqual({ promoted: 0, skipped: 1, through: "2026-10-24#1" });
  expect(
    readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8").match(/deploy uses docker/g),
  ).toHaveLength(1);
});

test("an over-long picked note is skipped and counted, never stored cut", async () => {
  const { root, mem } = setup();
  const r = await consolidateOwner(mem, ann, now, async () => [
    { kind: "fact", note: `deploy ${"word ".repeat(60)}` },
  ]);
  expect(r).toEqual({ promoted: 0, skipped: 1, through: "2026-10-24#1" });
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
  expect(n).toBe(5);
  expect(readConsolidatedMark(root, { kind: "group", groupId: "team" })).toEqual({
    day: "2026-10-21",
    count: 1,
  });
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
    { signal: ac.signal },
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
  expect(r).toEqual({ promoted: 1, skipped: 3, through: "2026-10-24#1" });
  const file = readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8");
  expect(file.match(/short answers/gi)).toHaveLength(1);
  expect(file.match(/docker compose/gi)).toHaveLength(1);
  expect(readConsolidatedMark(root, ann)).toEqual({ day: "2026-10-24", count: 1 });
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
  expect(r.through).toBe("2026-10-21#250");
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
  expect(r).toEqual({ promoted: 1, skipped: 0, through: "2026-10-24#1" });
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

test("a replacement of another kind is added as a new note, the old line stays in its section", async () => {
  const { root, mem } = setup();
  await mem.save(ann, "owner wants answers in Vietnamese", "preference");
  const r = await consolidateOwner(mem, ann, now, async () => [
    { kind: "fact", note: "owner's bank account is at Vietcombank", replaces: 1 },
  ]);
  expect(r.promoted).toBe(1);
  const file = readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8");
  expect(file).toContain("## Preferences\n- owner wants answers in Vietnamese");
  expect(file).toMatch(/## Facts\n- owner's bank account is at Vietcombank/);
});

test("a hand-written day over the caps is still sent whole", async () => {
  const root = mkdtempSync(join(tmpdir(), "cons-"));
  const mem = new FileMemory(root, () => now);
  const dir = join(root, "bots", "ann", "journal");
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 400 }, (_, i) => `- hand note ${i} about the release plan`);
  writeFileSync(join(dir, "2026-10-21.md"), `# Journal 2026-10-21\n${lines.join("\n")}\n`);
  let got: string[] = [];
  const r = await consolidateOwner(mem, ann, now, async (_m, notes) => {
    got = notes;
    return [];
  });
  expect(got).toHaveLength(400);
  expect(r.through).toBe("2026-10-21#400");
});

/** A fresh memory root with no journal. */
function empty() {
  const root = mkdtempSync(join(tmpdir(), "cons-"));
  return { root, mem: new FileMemory(root, () => now) };
}

test("takes today's notes after the mark", async () => {
  const { root, mem } = empty();
  appendJournal(
    root,
    ann,
    "Flush",
    ["first note here", "second note here"],
    at("2026-10-24T09:00:00"),
  );
  appendJournal(root, ann, "Flush", ["third note here"], at("2026-10-24T10:00:00"));
  writeConsolidatedMark(root, ann, "2026-10-24", 1);
  let got: string[] = [];
  const r = await consolidateOwner(mem, ann, now, async (_m, notes) => {
    got = notes;
    return [];
  });
  expect(got).toEqual(["second note here", "third note here"]);
  expect(r.through).toBe("2026-10-24#3");
  expect(readConsolidatedMark(root, ann)).toEqual({ day: "2026-10-24", count: 3 });
});

test("deleted lines count as consumed", async () => {
  const { root, mem } = empty();
  appendJournal(
    root,
    ann,
    "Flush",
    ["first note here", "second note here"],
    at("2026-10-22T09:00:00"),
  );
  appendJournal(root, ann, "Flush", ["later note here"], at("2026-10-23T09:00:00"));
  writeConsolidatedMark(root, ann, "2026-10-22", 5);
  let got: string[] = [];
  await consolidateOwner(mem, ann, now, async (_m, notes) => {
    got = notes;
    return [];
  });
  expect(got).toEqual(["later note here"]);
  expect(readConsolidatedMark(root, ann)).toEqual({ day: "2026-10-23", count: 1 });
});

test("old mark consumes the whole day", async () => {
  const { root, mem } = empty();
  appendJournal(root, ann, "Flush", ["old day note"], at("2026-10-22T09:00:00"));
  appendJournal(root, ann, "Flush", ["new day note"], at("2026-10-23T09:00:00"));
  writeFileSync(join(root, "bots", "ann", "journal", ".consolidated"), "2026-10-22\n");
  let got: string[] = [];
  await consolidateOwner(mem, ann, now, async (_m, notes) => {
    got = notes;
    return [];
  });
  expect(got).toEqual(["new day note"]);
});

test("group-sourced candidates get their own call; its facts are saved as lessons", async () => {
  const { root, mem } = empty();
  appendJournal(root, ann, "Idle flush", ["direct fact about deploys"], at("2026-10-24T09:00:00"));
  appendJournal(
    root,
    ann,
    groupLabel("Idle flush", "team"),
    ["group fact about the release"],
    at("2026-10-24T09:05:00"),
  );
  const calls: string[][] = [];
  const r = await consolidateOwner(mem, ann, now, async (_m, notes) => {
    calls.push(notes);
    return notes.map((note) => ({ kind: "fact" as const, note }));
  });
  expect(calls).toEqual([["direct fact about deploys"], ["group fact about the release"]]);
  expect(r).toEqual({ promoted: 2, skipped: 0, through: "2026-10-24#2" });
  const file = readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8");
  expect(file).toMatch(/## Facts\n- direct fact about deploys/);
  expect(file).toMatch(/## Lessons\n- group fact about the release/);
});

test("the mark moves only when both calls answered", async () => {
  const { root, mem } = empty();
  appendJournal(root, ann, "Idle flush", ["direct fact about deploys"], at("2026-10-24T09:00:00"));
  appendJournal(root, ann, "Idle flush @team", ["group fact here"], at("2026-10-24T09:05:00"));
  let n = 0;
  const r = await consolidateOwner(mem, ann, now, async (_m, notes) =>
    n++ === 0 ? notes.map((note) => ({ kind: "fact" as const, note })) : undefined,
  );
  expect(n).toBe(2);
  expect(r).toEqual({ promoted: 0, skipped: 0 });
  expect(readConsolidatedMark(root, ann)).toBeUndefined();
  expect(existsSync(join(root, "bots", "ann", "MEMORY.md"))).toBe(false);
});

test("a group owner's labeled notes are asked in one call", async () => {
  const { root, mem } = empty();
  const team: MemoryOwner = { kind: "group", groupId: "team" };
  appendJournal(root, team, "Idle flush", ["team uses bun"], at("2026-10-24T09:00:00"));
  appendJournal(
    root,
    team,
    "Idle flush @team",
    ["team ships on friday"],
    at("2026-10-24T09:05:00"),
  );
  let calls = 0;
  await consolidateOwner(mem, team, now, async () => {
    calls++;
    return [];
  });
  expect(calls).toBe(1);
});

test("known is passed to ask", async () => {
  const { mem } = setup();
  const seen: (string | undefined)[] = [];
  await consolidateAll(
    mem,
    now,
    async (_m, _n, known) => {
      seen.push(known);
      return [];
    },
    { known: async (o) => (o.kind === "bot" ? `known ${o.botId}` : undefined) },
  );
  expect(seen).toEqual(["known ann"]);
  const { mem: mem2 } = setup();
  let direct: string | undefined;
  await consolidateOwner(
    mem2,
    ann,
    now,
    async (_m, _n, known) => {
      direct = known;
      return [];
    },
    "USER says hi",
  );
  expect(direct).toBe("USER says hi");
});
