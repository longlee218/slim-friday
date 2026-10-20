import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  citesExpected,
  loadCodeCases,
  pathLineRefs,
  REPO_ROOT,
} from "./scout-codebase-eval-support";

/* Shape of the scout codebase set (no API call; the paid run is scout-codebase.eval.test.ts). */

const cases = loadCodeCases();

test("codebase set: 5-8 cases, unique ids and texts, every expected path exists in the repo", () => {
  expect(cases.length).toBeGreaterThanOrEqual(5);
  expect(cases.length).toBeLessThanOrEqual(8);
  expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  expect(new Set(cases.map((c) => c.text)).size).toBe(cases.length);
  for (const c of cases) {
    expect(c.expect.length).toBeGreaterThan(0);
    for (const p of c.expect) expect(existsSync(join(REPO_ROOT, p))).toBe(true);
  }
});

test("pathLineRefs: path:line and path:line-range, in backticks or links; bare paths are not refs", () => {
  expect(
    pathLineRefs("see `src/a/b.ts:12`, [x](src/c.ts:3-9) and src/d.ts with /abs/e.json:1"),
  ).toEqual(["src/a/b.ts", "src/c.ts", "/abs/e.json"]);
  expect(pathLineRefs("no refs in src/d.ts")).toEqual([]);
});

test("citesExpected: a path:line of an expected path passes, absolute paths included; a bare path does not", () => {
  const exp = ["src/config/resilience-caps.ts"];
  expect(citesExpected("`src/config/resilience-caps.ts:5`", exp)).toBe(true);
  expect(citesExpected("/Users/x/repo/src/config/resilience-caps.ts:5", exp)).toBe(true);
  expect(citesExpected("src/config/resilience-caps.ts", exp)).toBe(false);
  expect(citesExpected("src/config/lead-caps.ts:3", exp)).toBe(false);
});
