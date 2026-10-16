import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

/** Env is read only inside src/config/ (config/process-env.ts is the one reader others call). */
test("no process.env outside src/config", () => {
  const offenders: string[] = [];
  for (const file of new Glob("src/**/*.ts").scanSync(".")) {
    if (file.startsWith("src/config/")) continue;
    // Whole-line `//` and ` * ` comments may mention process.env; code never does.
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l));
    if (code.some((l) => l.includes("process.env"))) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
