import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

/** Env is read only inside apps/friday/src/config/ (process-env.ts is the one reader others call). */
test("no process.env outside apps/friday/src/config", () => {
  const offenders: string[] = [];
  for (const file of new Glob("{apps,packages}/*/src/**/*.ts").scanSync(".")) {
    if (file.startsWith("apps/friday/src/config/")) continue;
    // Whole-line `//` and ` * ` comments may mention process.env; code never does.
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l));
    if (code.some((l) => l.includes("process.env"))) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
