import { expect, test } from "bun:test";
import {
  datedBullets,
  replaceDatedBullets,
  shrinkStats,
  shrinksTooMuch,
} from "../src/memory/dream-sections";

/* The safety core of dreaming: only dated bullets of the four kind sections may change, everything else is
   byte-identical (owner prose, headings, undated bullets, other sections, line endings). */

const FILE = [
  "# Memory ops",
  "Owner intro line, hand written.",
  "",
  "## Decisions",
  "- keep postgres (2026-10-01)",
  "- owner note without a date",
  "- use bun (2026-10-02)",
  "Owner prose inside the section.",
  "",
  "## Notes",
  "- dated but not a kind section (2026-10-03)",
  "",
  "## Facts",
  "- api runs on port 3000 (2026-10-04)",
  "",
].join("\n");

test("datedBullets reads dated lines of the kind section only", () => {
  expect(datedBullets(FILE, "decision")).toEqual([
    "- keep postgres (2026-10-01)",
    "- use bun (2026-10-02)",
  ]);
  expect(datedBullets(FILE, "fact")).toEqual(["- api runs on port 3000 (2026-10-04)"]);
  expect(datedBullets(FILE, "lesson")).toEqual([]);
});

test("replace keeps every other line byte-identical", () => {
  const out = replaceDatedBullets(FILE, "decision", ["- keep postgres and use bun (2026-10-02)"]);
  const lines = out.split("\n");
  expect(lines).toEqual([
    "# Memory ops",
    "Owner intro line, hand written.",
    "",
    "## Decisions",
    "- keep postgres and use bun (2026-10-02)",
    "- owner note without a date",
    "Owner prose inside the section.",
    "",
    "## Notes",
    "- dated but not a kind section (2026-10-03)",
    "",
    "## Facts",
    "- api runs on port 3000 (2026-10-04)",
    "",
  ]);
});

test("a section with no dated bullet gets the set after its last line; a missing section is appended", () => {
  const a = replaceDatedBullets("## Lessons\n- owner lesson\n\n## Facts\n", "lesson", [
    "- new (2026-10-05)",
  ]);
  expect(a).toBe("## Lessons\n- owner lesson\n- new (2026-10-05)\n\n## Facts\n");
  const b = replaceDatedBullets("# T\ntext\n", "preference", ["- likes short (2026-10-05)"]);
  expect(b).toBe("# T\ntext\n\n## Preferences\n- likes short (2026-10-05)\n");
  // Empty set + missing section: nothing is added.
  expect(replaceDatedBullets("# T\n", "lesson", [])).toBe("# T\n");
});

test("CRLF files keep their line ending", () => {
  const crlf = FILE.replace(/\n/g, "\r\n");
  const out = replaceDatedBullets(crlf, "fact", [
    "- api on 3000 (2026-10-04)",
    "- db is pg (2026-10-05)",
  ]);
  expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  expect(out).toContain("- db is pg (2026-10-05)\r\n");
  expect(out).toContain("# Memory ops\r\nOwner intro line, hand written.\r\n");
});

test("a result equal to the input is byte-identical", () => {
  const same = replaceDatedBullets(FILE, "decision", datedBullets(FILE, "decision"));
  expect(same).toBe(FILE);
});

test("shrink guard: distinct drops are refused, near-duplicate merges pass", () => {
  const distinct = Array.from(
    { length: 10 },
    (_, i) => `- topic${i}alpha unique${i}beta words${i}gamma (2026-10-01)`,
  );
  const keep = distinct.slice(0, 4);
  const s1 = shrinkStats(distinct, keep);
  expect(s1).toEqual({ lost: 6, dupes: 0, clusters: 0 });
  expect(shrinksTooMuch(s1, 10, 0.5)).toBe(true);

  // 6 near-duplicates of one sentence + 4 distinct notes, merged into one + the 4: 5 of 10 collapsed.
  const dup = Array.from(
    { length: 6 },
    (_, i) =>
      `- deploy runs every friday evening with extra${i === 0 ? "" : ` v${i}`} (2026-10-0${i + 1})`,
  );
  const rest = distinct.slice(0, 4);
  const s2 = shrinkStats([...dup, ...rest], [dup[0] as string, ...rest]);
  expect(s2.lost).toBe(0);
  expect(shrinksTooMuch(s2, 10, 0.5)).toBe(false);
  // Over half lost but all of it explained by duplicates: allowed.
  expect(shrinksTooMuch({ lost: 6, dupes: 7, clusters: 1 }, 10, 0.5)).toBe(false);
  expect(shrinksTooMuch({ lost: 5, dupes: 0, clusters: 0 }, 10, 0.5)).toBe(false); // exactly half is not over half
});

test("shrink guard: 4 near-duplicates and an empty result are refused (one representative must stay)", () => {
  const dups = ["alpha", "bravo", "charlie", "delta"].map(
    (w, i) => `- deploy runs every friday evening staging cluster ${w} (2026-10-0${i + 1})`,
  );
  const s = shrinkStats(dups, []);
  expect(s).toEqual({ lost: 4, dupes: 4, clusters: 1 });
  expect(shrinksTooMuch(s, 4, 0.5)).toBe(true);
  expect(shrinksTooMuch(shrinkStats(dups, [dups[0] as string]), 4, 0.5)).toBe(false);
});

test("only top-level bullets of a kind section are candidates; sub-bullets, ### sections and fences stay", () => {
  const f = [
    "## Facts",
    "- top (2026-01-01)",
    "  - sub (2026-01-01)",
    "```",
    "- fenced (2026-01-01)",
    "```",
    "### Sub heading",
    "- under h3 (2026-01-01)",
    "",
  ].join("\n");
  expect(datedBullets(f, "fact")).toEqual(["- top (2026-01-01)"]);
  const out = replaceDatedBullets(f, "fact", ["- merged (2026-01-02)"]);
  expect(out).toBe(f.replace("- top (2026-01-01)", "- merged (2026-01-02)"));
  expect(replaceDatedBullets(f, "fact", [])).toContain("  - sub (2026-01-01)");
});
