import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { capMemory } from "../src/memory/memory-cap";
import { type CompactLlm, compactTargets } from "../src/memory/memory-compaction";
import {
  buildCompacted,
  compactionSystem,
  parseCompacted,
} from "../src/memory/memory-compaction-prompt";
import { saveJournalBullet, saveMemoryBullet } from "../src/memory/memory-section-writer";
import {
  formatBullet,
  hasBullet,
  insertBullet,
  insertJournalEntry,
  normalizeBullet,
} from "../src/memory/memory-sections";
import type { MemoryTarget } from "../src/memory/memory-targets";
import { appendTaskMemory } from "../src/memory/memory-writer";
import { repoMemoryFile } from "../src/memory/repo-memory";
import { emptyUsage } from "../src/observability/record-run";
import { makeEnv } from "./helpers";

const b = (t: string, d = "2026-10-13") => formatBullet(t, d);
const tmp = () => join(mkdtempSync(join(tmpdir(), "sections-")), "MEMORY.md");

test("empty file: section created", () => {
  expect(insertBullet("", "fact", b("a"))).toBe("## Facts\n- a (2026-10-13)\n");
});

test("owner prose only: byte-identical prefix, section appended after it", () => {
  const owner = "# repo memory\n\nMy own notes.\nSecond line.\n";
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
  expect(
    saveMemoryBullet(f, "# r memory\n", "lesson", "Always run tests", "2026-10-13", 8000),
  ).toBe("saved");
  expect(
    saveMemoryBullet(f, "# r memory\n", "lesson", "always run tests.", "2026-10-14", 8000),
  ).toBe("duplicate");
  expect(saveMemoryBullet(f, "# r memory\n", "fact", "  ", "2026-10-13", 8000)).toBe("empty");
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
    8000,
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

test("legacy trim never drops kind sections", () => {
  const env = makeEnv();
  const f = repoMemoryFile(env.home, "main", "repo");
  const filler = (n: number) => Array.from({ length: 40 }, (_, i) => `- n${n} ${i}`).join("\n");
  const secs = Array.from({ length: 9 }, (_, i) => `## 2026-01-0${i + 1} t\n${filler(i)}`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `# h\n\n## Decisions\n- keep me (2026-01-01)\n\n${secs.join("\n\n")}\n`);
  appendTaskMemory(env.home, "main", "repo", "t", { bullets: ["fresh"], globalBullets: [] });
  const txt = readFileSync(f, "utf8");
  expect(txt).toContain("## Decisions\n- keep me");
  expect(txt).not.toContain("## 2026-01-01 t");
  expect(txt).toContain("- fresh");
});

test("compaction parse: known headings kept, others rejected; build keeps sections", () => {
  expect(parseCompacted("## Notes\n- a b c").ok).toBe(false);
  const p = parseCompacted(
    "- loose one\n## Decisions\n- d one\n## Facts\n- f one\n## Decisions\n- d two",
  );
  expect(p.ok && p.groups?.map((g) => [g.heading, g.bullets.length])).toEqual([
    ["", 1],
    ["Decisions", 2],
    ["Facts", 1],
  ]);
  if (!p.ok) throw new Error("x");
  const out = buildCompacted(
    "# t\n\nTpl.\n\n## 2026-02-02 x\n- one\n",
    "# t\n",
    p.bullets,
    "2026-10-13",
    p.groups,
  );
  expect(out.text).toBe(
    "# t\n\nTpl.\n\n## compacted 2026-02-02..2026-02-02\n- loose one\n\n## Decisions\n- d one\n- d two\n\n## Facts\n- f one\n",
  );
  expect(compactionSystem(8000)).toContain('"## Decisions"');
});

test("compaction end to end on a sectioned file keeps sections and merges across dates", async () => {
  const f = tmp();
  const dec = Array.from(
    { length: 60 },
    (_, i) =>
      `- the deploy pipeline step number ${i} uses cache folder alpha${i} (2026-10-0${(i % 9) + 1})`,
  );
  const fact = Array.from(
    { length: 60 },
    (_, i) => `- the service port detail ${i} lives in config zeta${i} (2026-09-01)`,
  );
  writeFileSync(
    f,
    `# r memory\n\nIntro.\n\n## Decisions\n${dec.join("\n")}\n\n## Facts\n${fact.join("\n")}\n`,
  );
  const t: MemoryTarget = { file: f, label: "r", cap: 8000, template: "# r memory\n" };
  const llm: CompactLlm = async () => ({
    text: `## Decisions\n${dec.slice(0, 5).join("\n")}\n## Facts\n${fact.slice(0, 3).join("\n")}`,
    usage: emptyUsage(),
  });
  const res = await compactTargets([t], llm, { dryRun: false });
  expect(res[0]?.status).toBe("compacted");
  const after = readFileSync(f, "utf8");
  expect(after).toContain("## Decisions\n- the deploy pipeline step number 0");
  expect(after).toContain("## Facts\n- the service port detail 0");
  expect(after).not.toContain("## compacted");
});

const ln = (n: number, tag: string) => `- ${tag} note number ${n} with some filler words`;
const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ln(i, tag)).join("\n");

test("cap: legacy file (no kind heading) keeps today's tail behavior", () => {
  const body = `# h\n\n## 2026-01-01 a\n${many(100, "old")}\n## 2026-02-01 b\n${many(100, "new")}`;
  expect(capMemory(body, 1000)).toBe(`...${body.slice(-1000)}`);
  expect(capMemory("short", 1000)).toBe("short");
});

test("cap: every kind section survives, keeps its newest bullets, no orphan bullets", () => {
  const body = `# h\n\nOwner prose.\n\n## Decisions\n${many(80, "dec")}\n\n## Facts\n${many(80, "fact")}\n\n## Lessons\n${many(80, "les")}\n`;
  const out = capMemory(body, 3000);
  expect(out.length).toBeLessThanOrEqual(3000);
  expect(out).toContain("# h\n\nOwner prose.");
  for (const h of ["Decisions", "Facts", "Lessons"]) expect(out).toContain(`## ${h}\n...\n- `);
  expect(out).toContain("dec note number 79 ");
  expect(out).not.toContain("dec note number 0 ");
  // every line is whole and every bullet sits under a heading
  const lines = out.split("\n");
  expect(
    lines.every(
      (l) =>
        l === "" ||
        l === "..." ||
        l.startsWith("#") ||
        l.endsWith("filler words") ||
        l === "Owner prose.",
    ),
  ).toBe(true);
  expect(lines.findIndex((l) => l.startsWith("- "))).toBeGreaterThan(
    lines.findIndex((l) => l === "## Decisions"),
  );
});

test("cap: unused budget flows to the big section; small sections kept whole", () => {
  const body = `# h\n\n## Decisions\n- tiny one\n\n## Facts\n${many(200, "fact")}\n`;
  const out = capMemory(body, 3000);
  expect(out).toContain("## Decisions\n- tiny one");
  expect(out.length).toBeGreaterThan(2500);
  expect(out.length).toBeLessThanOrEqual(3000);
});

test("cap: large owner prose gets about 40% and is tail-cut", () => {
  const body = `# h\n\n## My topic\n${many(200, "own")}\n\n## Facts\n${many(200, "fact")}\n`;
  const out = capMemory(body, 3000);
  expect(out).toContain("## Facts\n...");
  expect(out).toContain("own note number 199 ");
  expect(out).not.toContain("own note number 0 ");
  expect(out.length).toBeLessThanOrEqual(3000);
});

test("writer: refuses past the line limit or the char cap with 'full'", () => {
  const f = tmp();
  writeFileSync(f, `# r\n\n## Facts\n${many(296, "x")}\n`);
  expect(saveMemoryBullet(f, "# r\n", "fact", "one more", "2026-10-13", 100000)).toBe("saved");
  const before = readFileSync(f, "utf8");
  expect(saveMemoryBullet(f, "# r\n", "fact", "two more", "2026-10-13", 100000)).toBe("full");
  expect(readFileSync(f, "utf8")).toBe(before);
  const g = tmp();
  writeFileSync(g, "# r\n\n## Facts\n- a (2026-01-01)\n");
  expect(saveMemoryBullet(g, "# r\n", "fact", "b".repeat(100), "2026-10-13", 60)).toBe("full");
  const j = tmp();
  writeFileSync(j, `# J\n${many(300, "j")}\n`);
  expect(saveJournalBullet(j, { hhmm: "10:00", label: "t" }, "fact", "z", "2026-10-13")).toBe(
    "full",
  );
});

test("dedupe: an empty normalized key never matches", () => {
  const t = "## Facts\n- !!! (2026-01-01)\n";
  expect(hasBullet(t, "fact", "- ??? (2026-02-02)")).toBe(false);
});

function bigSectioned(): { f: string; t: MemoryTarget; dec: string[]; fact: string[] } {
  const f = tmp();
  const dec = Array.from(
    { length: 60 },
    (_, i) =>
      `- the deploy pipeline step number ${i} uses cache folder alpha${i} (2026-10-0${(i % 9) + 1})`,
  );
  const fact = Array.from(
    { length: 60 },
    (_, i) => `- the service port detail ${i} lives in config zeta${i} (2026-09-01)`,
  );
  writeFileSync(
    f,
    `# r memory\n\n## Decisions\n${dec.join("\n")}\n\n## Facts\n${fact.join("\n")}\n`,
  );
  return { f, t: { file: f, label: "r", cap: 8000, template: "# r memory\n" }, dec, fact };
}
const stubLlm =
  (text: string): CompactLlm =>
  async () => ({ text, usage: emptyUsage() });

test("compaction aborts when kind sections come back flat", async () => {
  const { t, dec } = bigSectioned();
  const res = await compactTargets([t], stubLlm(dec.slice(0, 5).join("\n")), { dryRun: false });
  expect(res[0]?.status).toBe("aborted");
});

test("compaction aborts when a bullet moves to another section", async () => {
  const { t, dec, fact } = bigSectioned();
  const res = await compactTargets(
    [t],
    stubLlm(`## Decisions\n${dec.slice(0, 3).join("\n")}\n## Facts\n${dec[5]}\n${fact[0]}`),
    { dryRun: true },
  );
  expect(res[0]?.status).toBe("aborted");
});

test("compaction aborts on an invented or refreshed date", async () => {
  const { t, dec } = bigSectioned();
  const bad = dec[0]?.replace("(2026-10-01)", "(2026-12-24)");
  const res = await compactTargets([t], stubLlm(`## Decisions\n${bad}\n${dec[1]}`), {
    dryRun: true,
  });
  expect(res[0]?.status).toBe("aborted");
  const ok = await compactTargets([t], stubLlm(`## Decisions\n${dec[0]}\n${dec[1]}`), {
    dryRun: true,
  });
  expect(ok[0]?.status).toBe("dry-run");
});
