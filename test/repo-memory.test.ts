import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendRepoMemory,
  buildMemoryContext,
  extractMemory,
  memoryFile,
  readRepoClaudeMd,
  readRepoMemory,
} from "../src/memory/repo-memory";
import { makeEnv } from "./helpers";

test("extractMemory splits the Memory: block off the reply", () => {
  const r = extractMemory("Xong.\n\nMemory:\n- run tests with `go test ./...`\n- config in cmd/\n");
  expect(r.text).toBe("Xong.");
  expect(r.bullets).toEqual(["run tests with `go test ./...`", "config in cmd/"]);
  expect(extractMemory("Xong, không có gì.")).toEqual({ text: "Xong, không có gì.", bullets: [] });
  const many = extractMemory(`ok\n## Memory\n${"- b\n".repeat(9)}`);
  expect(many.bullets).toHaveLength(5);
});

test("append + read: template is empty, entries are redacted, newest part is injected", () => {
  const env = makeEnv();
  const file = memoryFile(env.home, "api");
  mkdirSync(join(env.home, "workspaces", "api"), { recursive: true });
  writeFileSync(file, "# api memory\n\nLessons.\n");
  expect(readRepoMemory(env.home, "api")).toBe(""); // template only
  appendRepoMemory(env.home, "api", "Add endpoint", [
    "use zod",
    "key sk-ant-abcdefghijklmnop1234 leaked",
  ]);
  const m = readRepoMemory(env.home, "api");
  expect(m).toContain("Add endpoint");
  expect(m).toContain("- use zod");
  expect(m).not.toContain("sk-ant-abcdefghijklmnop1234");
  expect(buildMemoryContext(env.home, ["api", "missing"])).toContain("### api");
  expect(buildMemoryContext(env.home, ["missing"])).toBe("");
});

test("MEMORY.md stays at 300 lines: trimmed once it passes +5%, oldest sections dropped, header kept", () => {
  const env = makeEnv();
  let max = 0;
  for (let i = 0; i < 200; i++) {
    appendRepoMemory(env.home, "big", `task ${i}`, [`lesson ${i}`, `detail ${i}`]);
    max = Math.max(max, readFileSync(memoryFile(env.home, "big"), "utf8").split("\n").length);
  }
  const text = readFileSync(memoryFile(env.home, "big"), "utf8");
  expect(max).toBeLessThanOrEqual(316); // 300 + 5% (+ trailing newline)
  expect(text.split("\n").length).toBeGreaterThan(250); // trimmed to ~300, not emptied
  expect(text.startsWith("# big memory")).toBe(true);
  expect(text).toContain("task 199");
  expect(text).not.toContain("task 0\n");
});

test("readRepoClaudeMd reads the clone's CLAUDE.md, capped", () => {
  const env = makeEnv();
  writeFileSync(join(env.repo, "CLAUDE.md"), `rules ${"y".repeat(8000)}`);
  const t = readRepoClaudeMd(env.repo);
  expect(t).toContain("Repo instructions");
  expect(t).toContain("(truncated)");
  expect(readRepoClaudeMd(join(env.home, "nope"))).toBe("");
});
