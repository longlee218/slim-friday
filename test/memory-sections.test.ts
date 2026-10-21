import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveJournalBullet, saveMemoryBullet } from "../src/memory/memory-section-writer";
import {
  formatBullet,
  hasBullet,
  insertBullet,
  insertJournalEntry,
  normalizeBullet,
} from "../src/memory/memory-sections";

const b = (t: string, d = "2026-10-13") => formatBullet(t, d);
const tmp = () => join(mkdtempSync(join(tmpdir(), "sections-")), "MEMORY.md");

test("empty file: section created", () => {
  expect(insertBullet("", "fact", b("a"))).toBe("## Facts\n- a (2026-10-13)\n");
});

test("owner prose only: byte-identical prefix, section appended after it", () => {
  const owner = "# location memory\n\nMy own notes.\nSecond line.\n";
  const out = insertBullet(owner, "decision", b("use pnpm"));
  expect(out.startsWith(owner)).toBe(true);
  expect(out).toBe(`${owner}\n## Decisions\n- use pnpm (2026-10-13)\n`);
});

test("owner text without final newline stays a prefix", () => {
  const owner = "# t\nprose";
  const out = insertBullet(owner, "fact", b("a"));
  expect(out.startsWith(owner)).toBe(true);
  expect(out).toBe("# t\nprose\n\n## Facts\n- a (2026-10-13)\n");
});

test("bullet lands under the right heading with sections after it; others untouched", () => {
  const text =
    "# t\n\n## Decisions\n- d1 (2026-01-01)\n\n## Facts\n- f1 (2026-01-01)\n\n## My topic\n- x\n";
  const out = insertBullet(text, "decision", b("d2"));
  expect(out).toBe(
    "# t\n\n## Decisions\n- d1 (2026-01-01)\n- d2 (2026-10-13)\n\n## Facts\n- f1 (2026-01-01)\n\n## My topic\n- x\n",
  );
  const out2 = insertBullet(text, "fact", b("f2"));
  expect(out2).toContain("- f1 (2026-01-01)\n- f2 (2026-10-13)\n\n## My topic");
  // missing section goes to the end, after the owner's topic
  expect(
    insertBullet(text, "lesson", b("l")).endsWith(
      "## My topic\n- x\n\n## Lessons\n- l (2026-10-13)\n",
    ),
  ).toBe(true);
});

test("CRLF file keeps CRLF and its prefix", () => {
  const text = "# t\r\n\r\n## Facts\r\n- f1 (2026-01-01)\r\n";
  const out = insertBullet(text, "fact", b("f2"));
  expect(out).toBe("# t\r\n\r\n## Facts\r\n- f1 (2026-01-01)\r\n- f2 (2026-10-13)\r\n");
  const out2 = insertBullet(text, "lesson", b("l"));
  expect(out2.startsWith(text)).toBe(true);
  expect(out2).toContain("\r\n## Lessons\r\n- l (2026-10-13)\r\n");
  expect(out2.replace(/\r\n/g, "")).not.toContain("\n");
});

test("a heading-looking note cannot create a section; look-alike headings are not matched", () => {
  const text = "## Facts extra\n- keep\n";
  const out = insertBullet(text, "fact", b("## Decisions"));
  // `## Facts extra` is not `## Facts`: a new exact section is appended
  expect(out).toBe("## Facts extra\n- keep\n\n## Facts\n- ## Decisions (2026-10-13)\n");
  expect(out.split("\n").filter((l) => l === "## Decisions")).toHaveLength(0);
});

test("open is journal-only; dedupe key ignores date, case and punctuation", () => {
  expect(() => insertBullet("", "open", b("x"))).toThrow();
  const t = insertBullet("", "fact", b("Use Bun, not Node!", "2026-01-01"));
  expect(hasBullet(t, "fact", b("use bun not node", "2026-10-13"))).toBe(true);
  expect(hasBullet(t, "decision", b("use bun not node"))).toBe(false);
  expect(normalizeBullet("- Tiếng Việt  OK. (2026-01-01)")).toBe("tiếng việt ok");
});

test("journal: new block, same minute+label merges, other label/kind adds", () => {
  let t = "# Journal 2026-10-13\n";
  t = insertJournalEntry(t, "09:05", "thread A", "decision", b("d1"));
  expect(t).toBe("# Journal 2026-10-13\n\n## 09:05 thread A\n### Decisions\n- d1 (2026-10-13)\n");
  t = insertJournalEntry(t, "09:05", "thread A", "decision", b("d2"));
  t = insertJournalEntry(t, "09:05", "thread A", "open", b("o1"));
  t = insertJournalEntry(t, "09:05", "thread B", "fact", b("f1"));
  t = insertJournalEntry(t, "09:05", "thread A", "fact", b("f2"));
  expect(t).toBe(
    [
      "# Journal 2026-10-13",
      "",
      "## 09:05 thread A",
      "### Decisions",
      "- d1 (2026-10-13)",
      "- d2 (2026-10-13)",
      "### Open",
      "- o1 (2026-10-13)",
      "### Facts",
      "- f2 (2026-10-13)",
      "",
      "## 09:05 thread B",
      "### Facts",
      "- f1 (2026-10-13)",
      "",
    ].join("\n"),
  );
  const crlf = insertJournalEntry("# J\r\n", "09:05", "x", "fact", b("z"));
  expect(crlf).toBe("# J\r\n\r\n## 09:05 x\r\n### Facts\r\n- z (2026-10-13)\r\n");
  expect(() => insertJournalEntry(t, "9:5", "x", "fact", b("z"))).toThrow();
});

test("writer: sectioned save creates, dedupes, keeps owner text; legacy file loads", () => {
  const f = tmp();
  writeFileSync(f, "# r memory\n\nOwner note.\n\n## 2026-01-01 old\n- legacy bullet\n");
  expect(saveMemoryBullet(f, "# r memory\n", "lesson", "Always run tests", "2026-10-13")).toBe(
    "saved",
  );
  expect(saveMemoryBullet(f, "# r memory\n", "lesson", "always run tests.", "2026-10-14")).toBe(
    "duplicate",
  );
  expect(saveMemoryBullet(f, "# r memory\n", "fact", "  ", "2026-10-13")).toBe("empty");
  const txt = readFileSync(f, "utf8");
  expect(txt.startsWith("# r memory\n\nOwner note.\n\n## 2026-01-01 old\n- legacy bullet\n")).toBe(
    true,
  );
  expect(txt.endsWith("## Lessons\n- Always run tests (2026-10-13)\n")).toBe(true);
});

test("writer: new file uses the header; secrets redacted; journal merges in one file", () => {
  const f = tmp();
  saveMemoryBullet(
    f,
    "# new\n",
    "fact",
    "key sk-ant-api03-abcdefghijklmnopqrstuvwx here",
    "2026-10-13",
  );
  const txt = readFileSync(f, "utf8");
  expect(txt.startsWith("# new\n\n## Facts\n")).toBe(true);
  expect(txt).not.toContain("abcdefghijklmnop");
  const j = tmp();
  const slot = { hhmm: "10:00", label: "## evil\nlabel" };
  expect(saveJournalBullet(j, slot, "open", "todo x", "2026-10-13")).toBe("saved");
  expect(saveJournalBullet(j, slot, "open", "todo y", "2026-10-13")).toBe("saved");
  expect(saveJournalBullet(j, slot, "open", "todo x", "2026-10-13")).toBe("duplicate");
  const jt = readFileSync(j, "utf8");
  expect(jt.match(/^## 10:00 /gm)).toHaveLength(1);
  expect(jt).toContain("### Open\n- todo x (2026-10-13)\n- todo y (2026-10-13)\n");
});

const ln = (n: number, tag: string) => `- ${tag} note number ${n} with some filler words`;
const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ln(i, tag)).join("\n");

test("writer: no size limit on a MEMORY.md (300+ lines, 15000+ chars); the journal keeps the line guard", () => {
  const f = tmp();
  writeFileSync(f, `# r\n\n## Facts\n${many(400, "x")}\n`);
  expect(readFileSync(f, "utf8").length).toBeGreaterThan(15000);
  expect(saveMemoryBullet(f, "# r\n", "fact", "one more", "2026-10-13")).toBe("saved");
  expect(readFileSync(f, "utf8")).toContain("- one more (2026-10-13)");
  const j = tmp();
  writeFileSync(j, `# J\n${many(300, "j")}\n`);
  expect(saveJournalBullet(j, { hhmm: "10:00", label: "t" }, "fact", "z", "2026-10-13")).toBe(
    "full",
  );
});

test("writer: a note of 2000 chars is kept whole, a longer one is cut at 2000", () => {
  const f = tmp();
  expect(saveMemoryBullet(f, "# r\n", "fact", "a".repeat(2000), "2026-10-13")).toBe("saved");
  expect(readFileSync(f, "utf8")).toContain(`- ${"a".repeat(2000)} (2026-10-13)`);
  const g = tmp();
  saveMemoryBullet(g, "# r\n", "fact", "b".repeat(2500), "2026-10-13");
  expect(readFileSync(g, "utf8")).toContain(`- ${"b".repeat(2000)} (2026-10-13)`);
  expect(readFileSync(g, "utf8")).not.toContain("b".repeat(2001));
});

test("dedupe: an empty normalized key never matches", () => {
  const t = "## Facts\n- !!! (2026-01-01)\n";
  expect(hasBullet(t, "fact", "- ??? (2026-02-02)")).toBe(false);
});
