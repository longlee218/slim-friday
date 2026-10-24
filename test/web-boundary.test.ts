import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

/** Every source file of the web app (tests live outside `src/`). */
const files = [...new Glob("apps/web/src/**/*.{ts,tsx}").scanSync(".")];

test("apps/web has source files", () => {
  expect(files.length).toBeGreaterThan(0);
});

test("apps/web imports only @friday/contracts among @friday/*", () => {
  const badFridayImports = files.flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(/from\s+["'](@friday\/[^"'/]+)/g)]
      .filter((m) => m[1] !== "@friday/contracts")
      .map((m) => `${f}: ${m[1]}`),
  );
  expect(badFridayImports).toEqual([]);
});

test("apps/web reads import.meta.env only in src/config/env.ts", () => {
  const envReaders = files.filter((f) => /import\.meta\.env/.test(readFileSync(f, "utf8")));
  expect(envReaders).toEqual(["apps/web/src/config/env.ts"]);
});

test("apps/web has no process.env, node: imports or console.*", () => {
  const offenders = files.filter((f) =>
    /\bprocess\.env\b|from\s+["']node:|\bconsole\./.test(readFileSync(f, "utf8")),
  );
  expect(offenders).toEqual([]);
});
