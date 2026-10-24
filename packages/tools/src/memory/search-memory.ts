import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryOwner } from "@friday/core";
import { ownerDir } from "./file-memory";
import { journalDir } from "./journal";

/** One matching note: where it is (`memory` or a journal date), the line and how many query words it holds. */
export interface MemoryHit {
  source: string;
  line: string;
  score: number;
}

/** Longest line returned. */
const LINE_CHARS = 300;

/** Bullet lines of a file, or none when it is missing. */
const bulletsOf = (file: string): string[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("- "))
    : [];

/**
 * Plain-text search over the owner's MEMORY.md and journal (no index): each bullet scores the number of distinct
 * query words (2+ chars) it contains. Best first; on a tie MEMORY.md, then the newest journal day.
 */
export function searchMemory(
  root: string,
  owner: MemoryOwner,
  query: string,
  limit = 10,
): MemoryHit[] {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(
    (w) => w.length >= 2,
  );
  if (!words.length) return [];
  const sources: { source: string; lines: string[]; rank: number }[] = [
    { source: "memory", lines: bulletsOf(join(ownerDir(root, owner), "MEMORY.md")), rank: 0 },
  ];
  const jdir = journalDir(root, owner);
  if (existsSync(jdir))
    readdirSync(jdir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .forEach((f, i) => {
        sources.push({ source: f.slice(0, 10), lines: bulletsOf(join(jdir, f)), rank: i + 1 });
      });
  const hits = sources.flatMap(({ source, lines, rank }) =>
    lines.flatMap((line) => {
      const low = line.toLowerCase();
      const score = words.filter((w) => low.includes(w)).length;
      return score ? [{ source, line: line.slice(0, LINE_CHARS), score, rank }] : [];
    }),
  );
  return hits
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .slice(0, limit)
    .map(({ source, line, score }) => ({ source, line, score }));
}
