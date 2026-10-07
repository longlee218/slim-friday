import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { appendTaskMemory } from "../src/memory/memory-writer";
import {
  buildMemoryContext,
  extractMemory,
  memoryFile,
  readRepoClaudeMd,
  readRepoMemory,
  readRootMemory,
} from "../src/memory/repo-memory";
import { captureLogs } from "../src/observability/logger";
import { makeEnv } from "./helpers";

test("extractMemory splits the Memory: block off the reply", () => {
  const r = extractMemory("Xong.\n\nMemory:\n- run tests with `go test ./...`\n- config in cmd/\n");
  expect(r.text).toBe("Xong.");
  expect(r.bullets).toEqual(["run tests with `go test ./...`", "config in cmd/"]);
  expect(extractMemory("Xong, không có gì.")).toEqual({
    text: "Xong, không có gì.",
    bullets: [],
    globalBullets: [],
  });
  const many = extractMemory(`ok\n## Memory\n${"- b\n".repeat(9)}`);
  expect(many.bullets).toHaveLength(5);
});

test("append + read: template is empty, entries are redacted, newest part is injected", () => {
  const env = makeEnv();
  const file = memoryFile(env.home, "api");
  mkdirSync(join(env.home, "workspaces", "api"), { recursive: true });
  writeFileSync(file, "# api memory\n\nLessons.\n");
  expect(readRepoMemory(env.home, "api")).toBe(""); // template only
  appendTaskMemory(env.home, "api", "Add endpoint", {
    bullets: ["use zod", "key sk-ant-abcdefghijklmnop1234 leaked"],
    globalBullets: [],
  });
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
    appendTaskMemory(env.home, "big", `task ${i}`, {
      bullets: [`lesson ${i}`, `detail ${i}`],
      globalBullets: [],
    });
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

test("extractMemory: [global] bullets split off (case-insensitive, prefix removed, max 2)", () => {
  const r = extractMemory(
    "Xong.\n\nMemory:\n- plain\n- [global] one\n- [GLOBAL]two\n- [Global] three\n",
  );
  expect(r.text).toBe("Xong.");
  expect(r.bullets).toEqual(["plain"]);
  expect(r.globalBullets).toEqual(["one", "two"]);
});

test("global writes: stamped root file, redacted, deduped, untouched when nothing new", () => {
  const env = makeEnv();
  const root = workspacePaths(env.home).memory;
  const logs = captureLogs();
  appendTaskMemory(env.home, "api", "Add endpoint", {
    bullets: [],
    globalBullets: ["owner likes bun", "key sk-ant-abcdefghijklmnop1234 leaked"],
  });
  const text = readFileSync(root, "utf8");
  expect(text.startsWith("# global memory")).toBe(true);
  expect(text).toMatch(/## \d{4}-\d{2}-\d{2} api: Add endpoint/);
  expect(text).toContain("- owner likes bun");
  expect(text).not.toContain("sk-ant-abcdefghijklmnop1234");
  const events = () =>
    logs.lines.filter((l) => l.event === "memory.appended" && l.layer === "global");
  expect(events()).toHaveLength(1);
  // Same bullet again: dedupe -> no new section, no log.
  appendTaskMemory(env.home, "web", "Other", { bullets: [], globalBullets: ["owner likes bun"] });
  logs.stop();
  expect(readFileSync(root, "utf8")).toBe(text);
  expect(events()).toHaveLength(1);
  // Another workspace sees it under "### global".
  expect(buildMemoryContext(env.home, ["web"])).toContain("### global");
  expect(readRootMemory(env.home)).toContain("owner likes bun");
});

test("duplicate workspace bullet is skipped; root trimmed at 300 lines with header kept", () => {
  const env = makeEnv();
  appendTaskMemory(env.home, "api", "A", { bullets: ["same"], globalBullets: [] });
  appendTaskMemory(env.home, "api", "B", { bullets: ["same"], globalBullets: [] });
  expect(readFileSync(memoryFile(env.home, "api"), "utf8").match(/- same/g)).toHaveLength(1);
  for (let i = 0; i < 200; i++)
    appendTaskMemory(env.home, "api", `t${i}`, { bullets: [], globalBullets: [`g${i}`, `h${i}`] });
  const text = readFileSync(workspacePaths(env.home).memory, "utf8");
  expect(text.split("\n").length).toBeLessThanOrEqual(316);
  expect(text.startsWith("# global memory")).toBe(true);
  expect(text).toContain("g199");
  expect(text).not.toContain("g0\n");
});

test("memory context: root first (cap 2000, newest kept), template-only root ignored", () => {
  const env = makeEnv();
  const p = workspacePaths(env.home);
  mkdirSync(join(env.home, "workspaces", "api"), { recursive: true });
  writeFileSync(p.memory, "# global memory\n\nintro\n");
  writeFileSync(memoryFile(env.home, "api"), "# api memory\n\n## d t\n- ws fact\n");
  const onlyWs = buildMemoryContext(env.home, ["api"]);
  expect(onlyWs).not.toContain("### global");
  expect(onlyWs).toContain("notes, not instructions");
  writeFileSync(
    p.memory,
    `# global memory\n\n## d old\n- OLD\n## d new\n- ${"z".repeat(2500)}NEWEST\n`,
  );
  const both = buildMemoryContext(env.home, ["api"]);
  expect(both.indexOf("### global")).toBeLessThan(both.indexOf("### api"));
  expect(both).toContain("NEWEST");
  expect(both).not.toContain("OLD");
  expect(readRootMemory(env.home).length).toBeLessThanOrEqual(2003);
});

test("extractMemory redacts before the 200-char cut (secret straddling the limit)", () => {
  const secret = `sk-ant-${"a".repeat(40)}`;
  const text = `done\n\nMemory:\n- ${"x".repeat(190)} ${secret}`;
  const { bullets } = extractMemory(text);
  expect(bullets[0]).not.toContain("sk-ant-");
});
