import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

/** Raw SQL and direct db access live in packages/store-sqlite; every other module calls its repos. */
const FORBIDDEN: RegExp[] = [
  /\.(query|prepare)\s*[<(]/, // bun:sqlite statements (also `.query<Row, [string]>(`)
  /\bdb\s*\.\s*(exec|run|select|insert|update|delete)\s*[<(]/, // direct db handle use, drizzle included
  /["'`]\s*(SELECT|INSERT|UPDATE|DELETE)\s/, // a SQL statement string (not the bare "SELECT" tag name)
];

/** The only package that may hold SQL. */
const EXEMPT_DIRS = ["packages/store-sqlite/"];

test("no raw SQL or direct db access outside packages/store-sqlite", () => {
  const offenders: string[] = [];
  for (const file of new Glob("{apps,packages}/*/src/**/*.ts").scanSync(".")) {
    if (EXEMPT_DIRS.some((d) => file.startsWith(d))) continue;
    // Whole-line `//` and ` * ` comments may mention SQL words; code never does.
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l));
    if (code.some((l) => FORBIDDEN.some((re) => re.test(l)))) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
