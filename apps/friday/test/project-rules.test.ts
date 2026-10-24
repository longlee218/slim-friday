import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectRules } from "../src/project-rules";

describe("readProjectRules", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rules-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("CLAUDE.md wins over AGENTS.md", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "claude rules\n");
    writeFileSync(join(dir, "AGENTS.md"), "agents rules");
    expect(await readProjectRules(dir)).toEqual({ file: "CLAUDE.md", text: "claude rules" });
  });

  test("only AGENTS.md is used when CLAUDE.md is absent", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "agents rules");
    expect(await readProjectRules(dir)).toEqual({ file: "AGENTS.md", text: "agents rules" });
  });

  test("neither file gives undefined", async () => {
    expect(await readProjectRules(dir)).toBeUndefined();
  });

  test("a 30 000-char file is cut to 8 000 chars ending in an ellipsis", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "a".repeat(30_000));
    const rules = await readProjectRules(dir);
    expect(rules?.text.length).toBe(8_000);
    expect(rules?.text.endsWith("…")).toBe(true);
  });

  test("a symlinked CLAUDE.md is skipped", async () => {
    writeFileSync(join(dir, "real.md"), "secret");
    symlinkSync(join(dir, "real.md"), join(dir, "CLAUDE.md"));
    expect(await readProjectRules(dir)).toBeUndefined();
  });
});
