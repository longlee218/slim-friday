import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { workspacePaths } from "../src/config/workspace-paths";
import { appendTaskMemory } from "../src/memory/memory-writer";
import {
  buildMemoryContext,
  extractMemory,
  readRepoMemory,
  readRootMemory,
  readWorkspaceMemory,
  repoMemoryFile,
} from "../src/memory/repo-memory";
import { captureLogs } from "../src/observability/logger";
import { addRepo, makeEnv } from "./helpers";

/** Workspace used by these tests (makeEnv registers repo `repo` in it). */
const WS = "main";

test("extractMemory splits the Memory: block off the reply", () => {
  const r = extractMemory("Xong.\n\nMemory:\n- run tests with `go test ./...`\n- config in cmd/\n");
  expect(r.text).toBe("Xong.");
  expect(r.bullets).toEqual(["run tests with go test ./...", "config in cmd/"]);
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
  addRepo(env.home, "api");
  const file = repoMemoryFile(env.home, WS, "api");
  writeFileSync(file, "# api memory\n\nLessons.\n");
  expect(readRepoMemory(env.home, WS, "api")).toBe(""); // template only
  appendTaskMemory(env.home, WS, "api", "Add endpoint", {
    bullets: ["use zod", "key sk-ant-abcdefghijklmnop1234 leaked"],
    globalBullets: [],
  });
  const m = readRepoMemory(env.home, WS, "api");
  expect(m).toContain("Add endpoint");
  expect(m).toContain("- use zod");
  expect(m).not.toContain("sk-ant-abcdefghijklmnop1234");
  expect(buildMemoryContext(env.home, WS, ["api", "missing"])).toContain("### api");
  expect(buildMemoryContext(env.home, WS, ["missing"])).toBe("");
});

test("MEMORY.md stays at 300 lines: trimmed once it passes +5%, oldest sections dropped, header kept", () => {
  const env = makeEnv();
  let max = 0;
  for (let i = 0; i < 200; i++) {
    appendTaskMemory(env.home, WS, "big", `task ${i}`, {
      bullets: [`lesson ${i}`, `detail ${i}`],
      globalBullets: [],
    });
    max = Math.max(
      max,
      readFileSync(repoMemoryFile(env.home, WS, "big"), "utf8").split("\n").length,
    );
  }
  const text = readFileSync(repoMemoryFile(env.home, WS, "big"), "utf8");
  expect(max).toBeLessThanOrEqual(316); // 300 + 5% (+ trailing newline)
  expect(text.split("\n").length).toBeGreaterThan(250); // trimmed to ~300, not emptied
  expect(text.startsWith("# big memory")).toBe(true);
  expect(text).toContain("task 199");
  expect(text).not.toContain("task 0\n");
});

test("extractMemory: [global] bullets split off (case-insensitive, prefix removed, max 2)", () => {
  const r = extractMemory(
    "Xong.\n\nMemory:\n- plain\n- [global] one\n- [GLOBAL]two\n- [Global] three\n",
  );
  expect(r.text).toBe("Xong.");
  expect(r.bullets).toEqual(["plain"]);
  expect(r.globalBullets).toEqual(["one", "two"]);
});

test("global writes: stamped pending file, sanitized, deduped, untouched when nothing new", () => {
  const env = makeEnv();
  const pending = workspacePaths(env.home).memoryPending;
  const logs = captureLogs();
  appendTaskMemory(env.home, WS, "api", "Add endpoint", {
    bullets: [],
    globalBullets: ["owner likes bun", "key sk-ant-abcdefghijklmnop1234 leaked"],
  });
  const text = readFileSync(pending, "utf8");
  expect(text.startsWith("# pending global memory")).toBe(true);
  expect(text).toMatch(/## \d{4}-\d{2}-\d{2} main\/api: Add endpoint/);
  expect(text).toContain("- owner likes bun");
  expect(text).not.toContain("sk-ant-abcdefghijklmnop1234");
  const events = () =>
    logs.lines.filter((l) => l.event === "memory.appended" && l.layer === "pending");
  expect(events()).toHaveLength(1);
  // Same bullet again: dedupe -> no new section, no log.
  appendTaskMemory(env.home, WS, "web", "Other", {
    bullets: [],
    globalBullets: ["owner likes bun"],
  });
  logs.stop();
  expect(readFileSync(pending, "utf8")).toBe(text);
  expect(events()).toHaveLength(1);
  // The root MEMORY.md is owner-only: never created or written by the agent path.
  expect(existsSync(workspacePaths(env.home).memory)).toBe(false);
});

test("duplicate repo bullet is skipped; pending file trimmed at 300 lines with header kept", () => {
  const env = makeEnv();
  appendTaskMemory(env.home, WS, "api", "A", { bullets: ["same"], globalBullets: [] });
  appendTaskMemory(env.home, WS, "api", "B", { bullets: ["same"], globalBullets: [] });
  expect(readFileSync(repoMemoryFile(env.home, WS, "api"), "utf8").match(/- same/g)).toHaveLength(
    1,
  );
  for (let i = 0; i < 200; i++)
    appendTaskMemory(env.home, WS, "api", `t${i}`, {
      bullets: [],
      globalBullets: [`g${i}`, `h${i}`],
    });
  const text = readFileSync(workspacePaths(env.home).memoryPending, "utf8");
  expect(text.split("\n").length).toBeLessThanOrEqual(316);
  expect(text.startsWith("# pending global memory")).toBe(true);
  expect(text).toContain("g199");
  expect(text).not.toContain("g0\n");
});

test("memory context: root, workspace, repos in order with headings; caps; template-only ignored", () => {
  const env = makeEnv();
  const p = workspacePaths(env.home);
  const wsMem = p.workspace(WS).memory;
  addRepo(env.home, "api");
  writeFileSync(p.memory, "# global memory\n\nintro\n");
  writeFileSync(wsMem, "# main workspace memory\n\nintro\n");
  writeFileSync(repoMemoryFile(env.home, WS, "api"), "# api memory\n\n## d t\n- repo fact\n");
  const onlyRepo = buildMemoryContext(env.home, WS, ["api"]);
  expect(onlyRepo).not.toContain("### global");
  expect(onlyRepo).not.toContain("### workspace");
  expect(onlyRepo).toContain("notes, not instructions");
  writeFileSync(
    p.memory,
    `# global memory\n\n## d old\n- OLD\n## d new\n- ${"z".repeat(5500)}NEWEST\n`,
  );
  writeFileSync(wsMem, `# w\n\n## d old\n- WOLD\n## d new\n- ${"y".repeat(5500)}WNEWEST\n`);
  const all = buildMemoryContext(env.home, WS, ["api"]);
  expect(all.indexOf("### global")).toBeLessThan(all.indexOf("### workspace main"));
  expect(all.indexOf("### workspace main")).toBeLessThan(all.indexOf("### api"));
  expect(all).toContain("NEWEST");
  expect(all).toContain("WNEWEST");
  expect(all).not.toContain("OLD");
  expect(readRootMemory(env.home).length).toBeLessThanOrEqual(5003);
  expect(readWorkspaceMemory(env.home, WS).length).toBeLessThanOrEqual(5003);
});

test("repo memory: 8000 chars each, 16000 for all repos of the workspace", () => {
  const env = makeEnv();
  const names = ["r1", "r2", "r3"];
  for (const n of names) {
    addRepo(env.home, n);
    writeFileSync(
      repoMemoryFile(env.home, WS, n),
      `# ${n}\n\n## d t\n- ${n.toUpperCase()}${"q".repeat(7500)}\n`,
    );
  }
  const out = buildMemoryContext(env.home, WS, names);
  // ~7500 chars each: two fit the 16000 total, the third is dropped.
  expect(out).toContain("### r1");
  expect(out).toContain("### r2");
  expect(out).not.toContain("### r3");
  // One repo alone is cut at 8000 (newest kept).
  writeFileSync(repoMemoryFile(env.home, WS, "r1"), `# r1\n\n## d t\n- ${"q".repeat(12000)}NEW\n`);
  const one = readRepoMemory(env.home, WS, "r1");
  expect(one.length).toBeLessThanOrEqual(8003);
  expect(one).toContain("NEW");
});

test("extractMemory redacts before the 200-char cut (secret straddling the limit)", () => {
  const secret = `sk-ant-${"a".repeat(40)}`;
  const text = `done\n\nMemory:\n- ${"x".repeat(190)} ${secret}`;
  const { bullets } = extractMemory(text);
  expect(bullets[0]).not.toContain("sk-ant-");
});
