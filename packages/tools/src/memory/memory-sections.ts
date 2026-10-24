/**
 * Pure text functions for the sectioned memory format (no I/O, no clock).
 *
 * MEMORY.md:  `## Decisions|Facts|Preferences|Lessons`, each bullet `- <text> (YYYY-MM-DD)`.
 * Journal:    `## HH:MM <label>` blocks, inside them `### Decisions|Facts|Preferences|Lessons|Open`.
 *
 * Owner text stays safe: only EXACT headings are recognised (other headings are left alone); a missing section is
 * APPENDED, existing lines are never rewritten, moved or removed; the file's line ending (LF or CRLF) is kept.
 */

import {
  appendBlock,
  ENDS_H2,
  ENDS_H3,
  findSection,
  insertInSection,
  type Section,
  toLines,
} from "./memory-section-lines";

/** Kinds of a note. `open` (an unresolved item) exists only in the journal. */
export const MEMORY_KINDS = ["decision", "fact", "preference", "lesson", "open"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Kind used when the caller gives none. */
export const DEFAULT_KIND: MemoryKind = "fact";

/** The one table kind -> section heading text (shared by MEMORY.md `##` and journal `###`). */
export const KIND_HEADING: Record<MemoryKind, string> = {
  decision: "Decisions",
  fact: "Facts",
  preference: "Preferences",
  lesson: "Lessons",
  open: "Open",
};

/** Kinds allowed in a MEMORY.md (everything but `open`), in the order sections are listed. */
export const MEMORY_FILE_KINDS: readonly MemoryKind[] = MEMORY_KINDS.filter((k) => k !== "open");

/** Headings of a MEMORY.md kind section, in canonical order. */
export const MEMORY_SECTION_HEADINGS: readonly string[] = MEMORY_FILE_KINDS.map(
  (k) => KIND_HEADING[k],
);

const HHMM = /^\d{2}:\d{2}$/;
const DATE_SUFFIX = / \(\d{4}-\d{2}-\d{2}\)$/;

/** `- <text> (YYYY-MM-DD)`: the bullet line stored in every file of this format. */
export const formatBullet = (text: string, date: string): string => `- ${text} (${date})`;

/** The bullet without its trailing date stamp (used to compare a bullet across dates). */
export const stripDateSuffix = (bullet: string): string => bullet.replace(DATE_SUFFIX, "");

/**
 * Comparison key of a bullet: no `- `, no date stamp, NFC lowercase, punctuation and runs of spaces collapsed.
 * Two bullets with the same key are the same note (dedupe in the writer, shared with the MemorySave tool).
 */
export const normalizeBullet = (line: string): string =>
  stripDateSuffix(line.trim().replace(/^- /, ""))
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Header line of a new journal file. */
export const journalHeader = (date: string): string => `# Journal ${date}\n`;

/** True when a found section holds a bullet with the same normalized key as `bullet` (an empty key never matches). */
const holds = (lines: string[], s: Section | null, bullet: string): boolean => {
  const key = normalizeBullet(bullet);
  return (
    key !== "" &&
    !!s &&
    lines
      .slice(s.head + 1, s.end)
      .map((l) => l.trim())
      .some((l) => l.startsWith("- ") && normalizeBullet(l) === key)
  );
};

/** Throw on a kind a MEMORY.md cannot hold (callers reject it before). */
function assertFileKind(kind: MemoryKind): void {
  if (kind === "open") throw new Error("kind 'open' exists only in the journal");
}

/** True when the MEMORY.md text already holds this note (same normalized bullet) in the kind's section. */
export function hasBullet(text: string, kind: MemoryKind, bullet: string): boolean {
  assertFileKind(kind);
  const { lines } = toLines(text);
  return holds(lines, findSection(lines, `## ${KIND_HEADING[kind]}`, ENDS_H2), bullet);
}

/**
 * Put `bullet` (a full `- ... (date)` line) under `## <Section of kind>` of a MEMORY.md text. Section missing:
 * it is appended at the end, after all existing text.
 */
export function insertBullet(text: string, kind: MemoryKind, bullet: string): string {
  assertFileKind(kind);
  const { lines, cr } = toLines(text);
  const heading = `## ${KIND_HEADING[kind]}`;
  const s = findSection(lines, heading, ENDS_H2);
  if (s) insertInSection(lines, s, [bullet + cr]);
  else appendBlock(lines, [heading + cr, bullet + cr], cr);
  return lines.join("\n");
}

/** Range of `## <hhmm> <label>`. */
const findBlock = (lines: string[], hhmm: string, label: string) =>
  findSection(lines, `## ${hhmm} ${label}`, ENDS_H2);

/** Validate HH:MM and flatten the label to one line (real sanitizing is the caller's). */
function journalHeading(hhmm: string, label: string): string {
  if (!HHMM.test(hhmm)) throw new Error(`bad journal time: ${hhmm}`);
  return label.replace(/\s+/g, " ").trim();
}

/** True when the journal block `## hhmm label` already holds this note under the kind's `###` subsection. */
export function hasJournalBullet(
  text: string,
  hhmm: string,
  label: string,
  kind: MemoryKind,
  bullet: string,
): boolean {
  const lbl = journalHeading(hhmm, label);
  const { lines } = toLines(text);
  const block = findBlock(lines, hhmm, lbl);
  if (!block) return false;
  const sub = findSection(lines, `### ${KIND_HEADING[kind]}`, ENDS_H3, block.head, block.end);
  return holds(lines, sub, bullet);
}

/**
 * Put `bullet` into the journal under `## hhmm label` / `### <Kind>`. The same time+label reuses the block
 * (a missing `###` kind is added at the end of that block); a new time or label starts a new block at the end.
 */
export function insertJournalEntry(
  text: string,
  hhmm: string,
  label: string,
  kind: MemoryKind,
  bullet: string,
): string {
  const lbl = journalHeading(hhmm, label);
  const { lines, cr } = toLines(text);
  const h3 = `### ${KIND_HEADING[kind]}`;
  const block = findBlock(lines, hhmm, lbl);
  if (!block) {
    appendBlock(lines, [`## ${hhmm} ${lbl}${cr}`, h3 + cr, bullet + cr], cr);
    return lines.join("\n");
  }
  const sub = findSection(lines, h3, ENDS_H3, block.head, block.end);
  if (sub) insertInSection(lines, sub, [bullet + cr]);
  else insertInSection(lines, block, [h3 + cr, bullet + cr]);
  return lines.join("\n");
}
