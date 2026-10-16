import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

/** Raw SQL and direct db access live in src/storage/*-store.ts; every other module calls those functions. */
const FORBIDDEN: RegExp[] = [
  /\.(query|prepare)\s*[<(]/, // bun:sqlite statements (also `.query<Row, [string]>(`)
  /\bdb\s*\.\s*(exec|run|select|insert|update|delete)\s*[<(]/, // direct db handle use, drizzle included
  /["'`]\s*(SELECT|INSERT|UPDATE|DELETE)\b/, // a SQL statement string
];

/** Directories that may hold SQL: the storage layer and the FTS index module (documented exception). */
const EXEMPT_DIRS = ["src/storage/", "src/memory/index/"];

/** Files that may keep a hit: `path: reason`. */
const ALLOW: Record<string, string> = {
  "src/mcp/mcp-servers.ts": "`manifest.prepare(ctx)` is an MCP manifest hook, not bun:sqlite",
};

test("no raw SQL or direct db access in src/ outside src/storage and src/memory/index", () => {
  const offenders: string[] = [];
  for (const file of new Glob("src/**/*.ts").scanSync(".")) {
    if (EXEMPT_DIRS.some((d) => file.startsWith(d)) || file in ALLOW) continue;
    // Whole-line `//` and ` * ` comments may mention SQL words; code never does.
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l));
    if (code.some((l) => FORBIDDEN.some((re) => re.test(l)))) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
