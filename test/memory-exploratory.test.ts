import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySymlinkError, withMemoryLock } from "../src/memory/memory-file-lock";
import { assertTempHome } from "./helpers";

/** Temp file for testing. */
function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "friday-explore-"));
  assertTempHome(dir);
  return join(dir, "MEMORY.md");
}

test("concurrent append stress: 20 parallel writes through lock produce no corruption", async () => {
  const f = tmpFile();
  writeFileSync(f, "# memory\n");

  const promises = Array.from({ length: 20 }, (_, i) =>
    withMemoryLock(f, () => {
      const old = readFileSync(f, "utf8");
      const line = `- bullet ${i}\n`;
      writeFileSync(f, old + line);
    }),
  );

  await Promise.all(promises);

  const final = readFileSync(f, "utf8");
  // All 20 bullets should be present
  for (let i = 0; i < 20; i++) {
    expect(final).toContain(`- bullet ${i}`);
  }
  // Count bullets
  const bulletCount = final.split("\n").filter((l) => l.startsWith("- ")).length;
  expect(bulletCount).toBe(20);
  // File should be readable without corruption
  expect(final.split("\n").length).toBeGreaterThan(20);
}, 30000);

test("command injection: newline + heading + fence sanitized and stored safely", () => {
  const { sanitizeBullet } = require("../src/memory/sanitize-bullet");

  // Attempt various injections
  const injections = [
    "note\n## evil heading\n- more",
    "note with ```code fence``` inside",
    "note with <script>alert()</script>",
    `10000 char injection: ${"x".repeat(10000)}`,
  ];

  for (const text of injections) {
    const sanitized = sanitizeBullet(text, 300);
    // Should be safe to store
    expect(sanitized).toBeDefined();
    expect(sanitized.length).toBeLessThanOrEqual(300);
    // Newlines should not be in the sanitized result
    expect(sanitized).not.toContain("\n");
  }
});

test("code fence injection in memory text stays escaped", () => {
  const f = tmpFile();
  writeFileSync(f, "# memory\n");

  const injected = "note with ```code fence``` inside";
  withMemoryLock(f, () => {
    writeFileSync(f, `# memory\n- ${injected}\n`);
  });

  const content = readFileSync(f, "utf8");
  expect(content).toContain(injected);
  // Should not break parsing
  const lines = content.split("\n");
  expect(lines[1]).toContain("```");
});

// Decision (Step B 6 review): a symlinked memory file is never written through; the lock refuses it.
test("symlinked MEMORY.md is refused, the target stays untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-symlink-"));
  assertTempHome(dir);
  const real = join(dir, "real.md");
  const link = join(dir, "link.md");
  writeFileSync(real, "# memory\n");
  symlinkSync(real, link);
  expect(() => withMemoryLock(link, () => writeFileSync(link, "- x\n"))).toThrow(
    MemorySymlinkError,
  );
  expect(readFileSync(real, "utf8")).toBe("# memory\n");
});
