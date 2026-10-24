import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJournal } from "../../src/memory/journal-read";
import {
  parseRules,
  readRules,
  renderRules,
  rulesForPrompt,
  writeRules,
} from "../../src/memory/rules-file";

const dev = { kind: "bot", botId: "dev" } as const;
const fresh = () => mkdtempSync(join(tmpdir(), "rules-"));
const file = (root: string) => join(root, "bots", "dev", "RULES.md");

test("51 rules refused, file unchanged", () => {
  const root = fresh();
  expect(() => writeRules(root, dev, Array(51).fill({ text: "a", on: true }))).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST", field: "rules" }),
  );
  expect(existsSync(file(root))).toBe(false);
});

test("501 chars, a newline and empty text are refused", () => {
  const root = fresh();
  for (const text of ["a".repeat(501), "a\nb", "   "]) {
    expect(() => writeRules(root, dev, [{ text, on: true }])).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  }
  expect(existsSync(file(root))).toBe(false);
});

test("round trip keeps order and on/off", () => {
  const root = fresh();
  const rs = [
    { text: "Never push to main.", on: true },
    { text: "PR in Vietnamese.", on: false },
  ];
  writeRules(root, dev, rs);
  expect(readFileSync(file(root), "utf8")).toContain(
    "- [x] Never push to main.\n- [ ] PR in Vietnamese.",
  );
  expect(readRules(root, dev)).toEqual(rs);
});

test("parse ignores other lines; render has a heading", () => {
  expect(parseRules("# Rules\n\nnote\n- [x] a\n- plain\n- [ ] b\n")).toEqual([
    { text: "a", on: true },
    { text: "b", on: false },
  ]);
  expect(renderRules([{ text: "a", on: true }])).toBe("# Rules\n\n- [x] a\n");
  expect(readRules(fresh(), dev)).toEqual([]);
});

test("rulesForPrompt lists only on rules", () => {
  const rs = [
    { text: "Never push to main.", on: true },
    { text: "PR in Vietnamese.", on: false },
  ];
  expect(rulesForPrompt(rs)).toBe("- Never push to main.");
  expect(rulesForPrompt([])).toBe("");
});

test("group owner writes under groups/<id>", () => {
  const root = fresh();
  writeRules(root, { kind: "group", groupId: "team" }, [{ text: "x", on: true }]);
  expect(existsSync(join(root, "groups", "team", "RULES.md"))).toBe(true);
});

test("journal by day and newest 7", () => {
  const root = fresh();
  const dir = join(root, "bots", "dev", "journal");
  mkdirSync(dir, { recursive: true });
  for (let d = 1; d <= 9; d++)
    writeFileSync(join(dir, `2026-10-0${d}.md`), `# Journal\n- note ${d}\nignored\n`);
  const all = readJournal(root, dev);
  expect(all).toHaveLength(7);
  expect(all[0]).toEqual({ day: "2026-10-09", items: ["note 9"] });
  expect(readJournal(root, dev, "2026-10-02")).toEqual([{ day: "2026-10-02", items: ["note 2"] }]);
  expect(readJournal(root, dev, "2026-11-01")).toEqual([]);
  expect(() => readJournal(root, dev, "../x")).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST" }),
  );
});
