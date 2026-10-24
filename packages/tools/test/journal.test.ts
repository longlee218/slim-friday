import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournal, pruneJournals, writeConsolidatedMark } from "../src/memory/journal";

const bot = { kind: "bot", botId: "ann" } as const;
const at = (iso: string) => new Date(iso);
const dayFile = (root: string, day: string) => join(root, "bots", "ann", "journal", `${day}.md`);

test("two appends on one day give two blocks in one file", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  expect(appendJournal(root, bot, "Flush", ["first"], at("2026-10-24T09:05:00"))).toBe("saved");
  expect(appendJournal(root, bot, "Flush", ["second"], at("2026-10-24T10:30:00"))).toBe("saved");
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
  expect(appendJournal(root, bot, "x", ["<b></b>", " "], at("2026-10-25T09:00:00"))).toBe("empty");
  expect(existsSync(dayFile(root, "2026-10-25"))).toBe(false);
});

test("a day file at 300 lines is full and left as is", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  const f = dayFile(root, "2026-10-24");
  mkdirSync(join(f, ".."), { recursive: true });
  const big = `${"- x\n".repeat(300)}`;
  writeFileSync(f, big);
  expect(appendJournal(root, bot, "Flush", ["more"], at("2026-10-24T09:00:00"))).toBe("full");
  expect(readFileSync(f, "utf8")).toBe(big);
});

test("prune deletes consolidated day files older than 30 days and keeps the rest", () => {
  const root = mkdtempSync(join(tmpdir(), "jr-"));
  appendJournal(root, bot, "F", ["old"], at("2026-09-23T09:00:00"));
  appendJournal(root, bot, "F", ["recent"], at("2026-09-25T09:00:00"));
  writeFileSync(join(root, "bots", "ann", "MEMORY.md"), "keep");
  writeConsolidatedMark(root, bot, "2026-10-20");
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
  writeConsolidatedMark(root, bot, "2026-09-14");
  expect(pruneJournals(root, at("2026-10-24T12:00:00"))).toBe(1);
  expect(existsSync(dayFile(root, "2026-09-14"))).toBe(false);
});
