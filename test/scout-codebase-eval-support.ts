import { readFileSync } from "node:fs";
import { join } from "node:path";

/* Support of the scout codebase eval: the fixture loader and the path:line scorer (the run itself reuses the
   researcher eval's outcome reader with role `scout`). */

/** The repository root: the eval registers it as the location `friday`. */
export const REPO_ROOT = join(import.meta.dir, "..");

/** Location name the eval registers the repository under. */
export const CODE_LOCATION = "friday";

/** One owner question about this repository. */
export interface CodeCase {
  id: string;
  text: string;
  /** Path substrings relative to the location root; a `path:line` citing one of them passes the case. */
  expect: string[];
}

/** The fixture file (test/fixtures/scout-codebase.json). */
export const loadCodeCases = (): CodeCase[] =>
  (
    JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "scout-codebase.json"), "utf8")) as {
      cases: CodeCase[];
    }
  ).cases;

/** Every `path:line` reference of a text (`a/b.ts:12`, `a/b.ts:12-30`), as the path part; backticks and links allowed around it. */
export function pathLineRefs(text: string): string[] {
  return [...text.matchAll(/([\w./-]+\.\w+):(\d+)/g)].map((m) => m[1] ?? "");
}

/** True when the text cites `path:line` for at least one expected path (substring match, absolute paths included). */
export const citesExpected = (text: string, expect: readonly string[]): boolean =>
  pathLineRefs(text).some((p) => expect.some((e) => p.includes(e)));
