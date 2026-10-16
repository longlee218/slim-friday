import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

/** Raw SQL and direct db access live in src/storage/*-store.ts; the orchestrator calls those functions. */
const FORBIDDEN: RegExp[] = [
  /\.(query|prepare)\s*[<(]/, // bun:sqlite statements (also `.query<Row, [string]>(`)
  /\bdb\s*\.\s*(exec|run|select|insert|update|delete)\s*[<(]/, // direct db handle use, drizzle included
  /["'`]\s*(SELECT|INSERT|UPDATE|DELETE)\b/, // a SQL statement string
];

/** Files that may keep a hit (none: every hit moved to storage). Add `path: reason` only with a comment. */
const ALLOW: Record<string, string> = {};

test("no raw SQL or direct db access under src/orchestrator", () => {
  const offenders: string[] = [];
  for (const file of new Glob("src/orchestrator/**/*.ts").scanSync(".")) {
    if (file in ALLOW) continue;
    // Whole-line `//` and ` * ` comments may mention SQL words; code never does.
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l));
    if (code.some((l) => FORBIDDEN.some((re) => re.test(l)))) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
