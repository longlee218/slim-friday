import { expect, test } from "bun:test";
import { join } from "node:path";

// Logging goes through pino only; this guards src/ against console.* creeping in.
test("no console.* in src/", async () => {
  const proc = Bun.spawn(["grep", "-rn", "console\\.", join(import.meta.dir, "..", "src")], {
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(out).toBe("");
});
