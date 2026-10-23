/**
 * Pure text functions of dreaming (no I/O, no clock): read and replace the DATED bullets of the four kind sections of
 * a channel MEMORY.md, and the shrink guard.
 *
 * Owner-safe rule: only a TOP-LEVEL bullet line `- <text> (YYYY-MM-DD)` (no indent) directly inside an exact
 * `## Decisions|Facts|Preferences|Lessons` section is a dream candidate: indented sub-bullets, bullets under a `###`
 * subheading and bullets inside a code fence are not. Every other line (owner prose, undated bullets, other headings and sections, blank
 * lines) stays byte for byte; the file's line ending (LF or CRLF) is kept.
 */

import { jaccard, tokensOf } from "../text/token-match";
import {
  appendBlock,
  ENDS_H3,
  findSection,
  insertInSection,
  toLines,
} from "./memory-section-lines";
import { KIND_HEADING, type MemoryKind, normalizeBullet } from "./memory-sections";

/** A dated bullet line: `- <text> (YYYY-MM-DD)`, no leading whitespace (a CRLF `\r` may end the line). */
const DATED_BULLET = /^- .+ \(\d{4}-\d{2}-\d{2}\)\r?$/;

/** Same threshold as the duplicate check of work items (`DUPLICATE_SUSPECT`). */
export const SIMILAR = 0.6;

/** Section of the kind in a MEMORY.md line list, or null. It ends at the next `#`, `##` or `###` heading. */
const sectionOf = (lines: string[], kind: MemoryKind) =>
  findSection(lines, `## ${KIND_HEADING[kind]}`, ENDS_H3);

/** Line indexes of the dream candidates of a section: top-level dated bullets outside code fences. */
function candidateIndexes(lines: string[], s: { head: number; end: number }): number[] {
  const out: number[] = [];
  let fenced = false;
  for (let i = s.head + 1; i < s.end; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && DATED_BULLET.test(line)) out.push(i);
  }
  return out;
}

/** The dated bullet lines (line end trimmed) of the kind's section, in file order. */
export function datedBullets(text: string, kind: MemoryKind): string[] {
  const { lines } = toLines(text);
  const s = sectionOf(lines, kind);
  if (!s) return [];
  return candidateIndexes(lines, s).map((i) => (lines[i] as string).trimEnd());
}

/**
 * Replace the dated bullets of the kind's section by `bullets` (full `- ... (date)` lines). The new bullets take the places
 * of the old dated ones in order; undated lines around them do not move. No old dated bullet: the set is added at the end
 * of the section (a missing section is appended). An empty `bullets` removes the dated ones.
 */
export function replaceDatedBullets(text: string, kind: MemoryKind, bullets: string[]): string {
  const { lines, cr } = toLines(text);
  const add = bullets.map((b) => b + cr);
  const s = sectionOf(lines, kind);
  if (!s) {
    if (add.length) appendBlock(lines, [`## ${KIND_HEADING[kind]}${cr}`, ...add], cr);
    return lines.join("\n");
  }
  const old = candidateIndexes(lines, s);
  if (!old.length) {
    if (add.length) insertInSection(lines, s, add);
    return lines.join("\n");
  }
  // New bullets take the old slots in order (so an unchanged set leaves the file byte-identical and undated lines never
  // move); extra new ones go after the last slot, leftover old slots are removed (bottom up, indexes stay valid).
  const keep = Math.min(old.length, add.length);
  for (let i = 0; i < keep; i++) lines[old[i] as number] = add[i] as string;
  if (add.length > keep) lines.splice((old[keep - 1] as number) + 1, 0, ...add.slice(keep));
  for (const i of old.slice(keep).reverse()) lines.splice(i, 1);
  return lines.join("\n");
}

/** Negation words (English and Vietnamese); any word ending in `n't` counts too. */
const NEGATIONS = new Set(["not", "never", "no", "cannot", "without", "không", "chưa", "đừng"]);

/** Marker tokens one negated bullet gets: enough weight that a negated bullet and its positive twin fall below SIMILAR. */
const NEGATION_WEIGHT = 3;

/** True when the text holds a negation word (apostrophes folded, so `don’t` = `don't`). */
const isNegated = (text: string): boolean =>
  text
    .toLowerCase()
    .replace(/’/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .some((w) => NEGATIONS.has(w) || w.endsWith("n't"));

/** Content words of a bullet (date and markup out, no negation markers). */
export const bulletWords = (bullet: string): Set<string> => tokensOf(normalizeBullet(bullet));

/**
 * Token set of a bullet for the similarity checks: its content words plus, when it holds a negation, NEGATION_WEIGHT
 * marker tokens (`tokensOf` drops short and stop words such as "not", so "Never deploy on Friday" and "Deploy on
 * Friday" would otherwise match). The ONE place both the save refusal and the dream shrink guard read.
 */
export const bulletTokens = (bullet: string): Set<string> => {
  const t = bulletWords(bullet);
  if (isNegated(bullet)) for (let i = 0; i < NEGATION_WEIGHT; i++) t.add(`\u0000neg${i}`);
  return t;
};

/**
 * Size-free shrink guard numbers. `lost` = existing bullets with no similar bullet (Jaccard >= SIMILAR, or the same
 * normalized text) in the result; `dupes` = existing bullets that have a near-duplicate among the other existing
 * bullets; `clusters` = groups of such near-duplicates (connected by similarity). A merge keeps one representative per
 * cluster, so at most `dupes - clusters` bullets can be collapsed away.
 */
export function shrinkStats(
  existing: readonly string[],
  result: readonly string[],
): { lost: number; dupes: number; clusters: number } {
  const ex = existing.map(bulletTokens);
  const out = result.map(bulletTokens);
  const exNorm = existing.map(normalizeBullet);
  const outNorm = new Set(result.map(normalizeBullet));
  const lost = ex.filter(
    (e, i) => !outNorm.has(exNorm[i] as string) && !out.some((o) => jaccard(e, o) >= SIMILAR),
  ).length;
  // Union-find over the existing bullets: one root per near-duplicate cluster.
  const root = ex.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (root[r] !== r) r = root[r] as number;
    return r;
  };
  for (let i = 0; i < ex.length; i++)
    for (let j = i + 1; j < ex.length; j++)
      if (jaccard(ex[i] as Set<string>, ex[j] as Set<string>) >= SIMILAR) root[find(i)] = find(j);
  const size = new Map<number, number>();
  for (let i = 0; i < ex.length; i++) size.set(find(i), (size.get(find(i)) ?? 0) + 1);
  const grouped = [...size.values()].filter((n) => n > 1);
  return { lost, dupes: grouped.reduce((a, n) => a + n, 0), clusters: grouped.length };
}

/**
 * True when the result must be refused. Allowed loss = what merging near-duplicates can remove (`dupes - clusters`,
 * one representative stays per cluster) plus `maxShare` of the distinct (non-duplicate) bullets.
 */
export const shrinksTooMuch = (
  s: { lost: number; dupes: number; clusters: number },
  existingCount: number,
  maxShare: number,
): boolean => s.lost > s.dupes - s.clusters + maxShare * (existingCount - s.dupes);
