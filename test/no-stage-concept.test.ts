import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Rev 15: roles are ONE run; the idea of a "stage" is gone from the code and the prompts. The whole word
 * `stage`/`stages` (any case) is banned in `src/**` .ts and .md files, except the frozen files that must still
 * name the old tables/columns (legacy migrations and the future v4 drop migration).
 */
const SRC = join(import.meta.dir, "..", "src");

/** Files that may name the old concept: the v2/v3 migrations (frozen) and the v4 migration that drops it. */
const ALLOWED = [
  /(^|\/)legacy-[^/]*$/,
  /(^|\/)migrate-v3-turns\.ts$/,
  /(^|\/)migrate-v4-drop-legacy-tables\.ts$/,
];

/** Every .ts / .md file under a directory (relative paths with "/"). */
function sourceFiles(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return sourceFiles(dir, path);
    return /\.(ts|md)$/.test(e.name) ? [path] : [];
  });
}

test("the word stage/stages appears nowhere in src except the frozen legacy files", () => {
  const files = sourceFiles(SRC);
  // Not vacuous: the scan really walked the source tree.
  expect(files.length).toBeGreaterThan(100);
  expect(files.some((f) => f.endsWith(".md"))).toBe(true);
  const hits: string[] = [];
  for (const f of files.filter((f) => !ALLOWED.some((re) => re.test(f)))) {
    readFileSync(join(SRC, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/\bstages?\b/i.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
  }
  expect(hits).toEqual([]);
});

/** Old table/column names that only the frozen legacy files and the v4 drop migration may spell out. */
const OLD_NAMES =
  /\b(stage_idx|after_plan|files_changed|files_top)\b|\b(FROM|INTO|TABLE|UPDATE|JOIN)\s+(IF\s+(NOT\s+)?EXISTS\s+)?(stages|worktrees)\b/i;

test("the old stage/clone table and column names appear in src only in the frozen legacy files and the v4 file", () => {
  const hits: string[] = [];
  for (const f of sourceFiles(SRC).filter((f) => !ALLOWED.some((re) => re.test(f)))) {
    readFileSync(join(SRC, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (OLD_NAMES.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
  }
  expect(hits).toEqual([]);
});
