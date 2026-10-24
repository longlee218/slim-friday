import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

// Logging goes through pino only; this guards apps/ and packages/ source against console.* creeping in.
test("no console.* in apps/*/src and packages/*/src", () => {
  const offenders: string[] = [];
  for (const file of new Glob("{apps,packages}/*/src/**/*.ts").scanSync(".")) {
    if (/\bconsole\./.test(readFileSync(file, "utf8"))) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
