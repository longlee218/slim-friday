import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendJournal,
  groupLabel,
  journalEntries,
  pruneJournals,
  readConsolidatedMark,
  writeConsolidatedMark,
} from "../src/memory/journal";

const bot = { kind: "bot", botId: "ann" } as const;
const at = (iso: string) => new Date(iso);
const dayFile = (root: string, day: string) => join(root, "bots", "ann", "journal", `${day}.md`);

test("two appends on one day give two blocks in one file", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  expect(appendJournal(root, bot, "Flush", ["first"], at("2026-10-24T09:05:00")).status).toBe(
    "saved",
  );
  expect(appendJournal(root, bot, "Flush", ["second"], at("2026-10-24T10:30:00")).status).toBe(
    "saved",
  );
  const text = readFileSync(dayFile(root, "2026-10-24"), "utf8");
  expect(text.startsWith("# Journal 2026-10-24\n")).toBe(true);
  expect(text).toContain("## 09:05 Flush\n- first");
  expect(text).toContain("## 10:30 Flush\n- second");
});

test("notes are cleaned, duplicates in one block dropped, all-empty writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  appendJournal(root, bot, "<i>Flush</i>", ["# <b>a</b>", "a", "", "b"], at("2026-10-24T09:00:00"));
  const text = readFileSync(dayFile(root, "2026-10-24"), "utf8");
  expect(text).not.toContain("<");
  expect(text.match(/^- a$/gm)).toHaveLength(1);
  expect(text).toContain("- b");
  expect(appendJournal(root, bot, "x", ["<b></b>", " "], at("2026-10-25T09:00:00")).status).toBe(
    "empty",
  );
  expect(existsSync(dayFile(root, "2026-10-25"))).toBe(false);
});

test("a note over 200 chars is cut at a word with a visible mark and counted", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  const long = `${"word ".repeat(70)}end`;
  const r = appendJournal(root, bot, "Flush", [long, "short"], at("2026-10-24T09:00:00"));
  expect(r).toEqual({ status: "saved", cut: 1, dropped: 0 });
  const line =
    readFileSync(dayFile(root, "2026-10-24"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("- word")) ?? "";
  expect(line.endsWith("word…")).toBe(true);
  expect(line.length - 2).toBeLessThanOrEqual(200);
});

test("a day file at 300 lines is full and left as is", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  const f = dayFile(root, "2026-10-24");
  mkdirSync(join(f, ".."), { recursive: true });
  const big = `${"- x\n".repeat(300)}`;
  writeFileSync(f, big);
  expect(appendJournal(root, bot, "Flush", ["more"], at("2026-10-24T09:00:00")).status).toBe(
    "full",
  );
  expect(readFileSync(f, "utf8")).toBe(big);
});

test("prune deletes consolidated day files older than 30 days and keeps the rest", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  appendJournal(root, bot, "F", ["old"], at("2026-09-23T09:00:00"));
  appendJournal(root, bot, "F", ["recent"], at("2026-09-25T09:00:00"));
  writeFileSync(join(root, "bots", "ann", "MEMORY.md"), "keep");
  writeFileSync(join(root, "bots", "ann", "journal", ".consolidated"), "2026-10-20\n");
  expect(pruneJournals(root, at("2026-10-24T12:00:00"))).toBe(1);
  expect(existsSync(dayFile(root, "2026-09-23"))).toBe(false);
  expect(existsSync(dayFile(root, "2026-09-25"))).toBe(true);
  expect(existsSync(join(root, "bots", "ann", "MEMORY.md"))).toBe(true);
});

test("prune keeps an unconsolidated old day until the mark passes it, and deletes any day older than 90", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  appendJournal(root, bot, "F", ["forty"], at("2026-09-14T09:00:00"));
  appendJournal(root, bot, "F", ["ancient"], at("2026-07-01T09:00:00"));
  expect(pruneJournals(root, at("2026-10-24T12:00:00"))).toBe(1);
  expect(existsSync(dayFile(root, "2026-07-01"))).toBe(false);
  expect(existsSync(dayFile(root, "2026-09-14"))).toBe(true);
  writeFileSync(join(root, "bots", "ann", "journal", ".consolidated"), "2026-09-14\n");
  expect(pruneJournals(root, at("2026-10-24T12:00:00"))).toBe(1);
  expect(existsSync(dayFile(root, "2026-09-14"))).toBe(false);
});

test("mark round-trips day#n", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  expect(readConsolidatedMark(root, bot)).toBeUndefined();
  writeConsolidatedMark(root, bot, "2026-10-26", 3);
  expect(readFileSync(join(root, "bots", "ann", "journal", ".consolidated"), "utf8")).toBe(
    "2026-10-26#3\n",
  );
  expect(readConsolidatedMark(root, bot)).toEqual({ day: "2026-10-26", count: 3 });
});

test("old mark format = whole day", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  mkdirSync(join(root, "bots", "ann", "journal"), { recursive: true });
  writeFileSync(join(root, "bots", "ann", "journal", ".consolidated"), "2026-10-25\n");
  expect(readConsolidatedMark(root, bot)).toEqual({ day: "2026-10-25" });
  writeFileSync(join(root, "bots", "ann", "journal", ".consolidated"), "junk\n");
  expect(readConsolidatedMark(root, bot)).toBeUndefined();
});

test("journalEntries keeps labels", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  appendJournal(root, bot, "Idle flush", ["direct one"], at("2026-10-26T09:00:00"));
  appendJournal(
    root,
    bot,
    groupLabel("Idle flush", "team"),
    ["group one"],
    at("2026-10-26T09:05:00"),
  );
  expect(journalEntries(root, bot, "2026-10-26")).toEqual([
    { note: "direct one", label: "Idle flush" },
    { note: "group one", label: "Idle flush @team" },
  ]);
});

test("prune: the mark day with #n is not passed, a day before it is", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  appendJournal(root, bot, "F", ["before"], at("2026-09-10T09:00:00"));
  appendJournal(root, bot, "F", ["mark day"], at("2026-09-11T09:00:00"));
  writeConsolidatedMark(root, bot, "2026-09-11", 1);
  expect(pruneJournals(root, at("2026-10-24T12:00:00"))).toBe(1);
  expect(existsSync(dayFile(root, "2026-09-10"))).toBe(false);
  expect(existsSync(dayFile(root, "2026-09-11"))).toBe(true);
});
