import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryOwner } from "@friday/core";
import { consolidateOwner } from "../src/memory/consolidate";
import { FileMemory } from "../src/memory/file-memory";
import { appendJournal, groupLabel } from "../src/memory/journal";

const ann: MemoryOwner = { kind: "bot", botId: "ann" };
const now = new Date("2026-10-24T12:00:00");

/** A bot memory with a hidden fact and a visible lesson, and one group-session journal note. */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "cons-group-"));
  const mem = new FileMemory(root, () => now);
  await mem.save(ann, "owner's bank is Vietcombank");
  await mem.save(ann, "run the linter before a push", "lesson");
  appendJournal(
    root,
    ann,
    groupLabel("Idle flush", "team"),
    ["run the tests before a push too"],
    new Date("2026-10-24T09:00:00"),
  );
  return { root, mem };
}

const memoryFile = (root: string) => readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8");

test("the group call sees only the notes group sessions see, numbered on their own", async () => {
  const { mem } = await setup();
  let shown = "";
  await consolidateOwner(mem, ann, now, async (m) => {
    shown = m;
    return [];
  });
  expect(shown).toBe("[1] (lesson) run the linter before a push");
});

test("a group pick's replaces names a note of that view and updates it", async () => {
  const { root, mem } = await setup();
  const r = await consolidateOwner(mem, ann, now, async () => [
    { kind: "lesson", note: "run the linter and the tests before a push", replaces: 1 },
  ]);
  expect(r.promoted).toBe(1);
  const file = memoryFile(root);
  expect(file).toContain("run the linter and the tests before a push");
  expect(file).not.toContain("- run the linter before a push (");
  expect(file).toContain("owner's bank is Vietcombank");
});

test("a group fact pick can never replace a hidden fact; out of range it is added as a lesson", async () => {
  const { root, mem } = await setup();
  const r = await consolidateOwner(mem, ann, now, async () => [
    { kind: "fact", note: "the release train leaves on Fridays", replaces: 2 },
  ]);
  expect(r.promoted).toBe(1);
  const file = memoryFile(root);
  expect(file).toMatch(/## Facts\n- owner's bank is Vietcombank/);
  expect(file).toContain("- run the linter before a push");
  expect(file).toMatch(/## Lessons\n(- .*\n)*- the release train leaves on Fridays/);
});
