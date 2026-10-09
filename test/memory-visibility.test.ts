import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { appendTaskMemory } from "../src/memory/memory-writer";
import { buildPromptContext } from "../src/memory/prompt-context";
import { repoMemoryFile } from "../src/memory/repo-memory";
import { captureLogs } from "../src/observability/logger";
import { addRepo, makeEnv } from "./helpers";

const WS = "main";
const ctx = (home: string, repos: string[]) =>
  buildPromptContext({ agentHome: home, workspace: WS, memoryRepos: repos });

/** A repo memory of `chars` body chars with at least one section. */
const fill = (home: string, repo: string, chars: number) =>
  writeFileSync(repoMemoryFile(home, WS, repo), `# ${repo}\n\n## s\n- ${"y".repeat(chars)}\n`);

test("a layer cut at read logs memory.truncated and sets memoryOverCap in prompt.context", () => {
  const env = makeEnv();
  fill(env.home, "repo", 4500);
  const logs = captureLogs();
  ctx(env.home, ["repo"]);
  logs.stop();
  expect(logs.lines.find((l) => l.event === "memory.truncated")).toMatchObject({
    level: 40,
    files: ["repo"],
  });
  expect(logs.lines.find((l) => l.event === "prompt.context")).toMatchObject({
    memoryOverCap: ["repo"],
  });
});

test("a repo skipped by the 8000 total logs memory.repo_skipped", () => {
  const env = makeEnv();
  for (const r of ["a", "b", "c"]) addRepo(env.home, r);
  for (const r of ["a", "b", "c"]) fill(env.home, r, 3500);
  const logs = captureLogs();
  ctx(env.home, ["a", "b", "c"]);
  logs.stop();
  expect(logs.lines.find((l) => l.event === "memory.repo_skipped")).toMatchObject({ repos: ["c"] });
  expect(logs.lines.find((l) => l.event === "prompt.context")).toMatchObject({ memoryOverCap: [] });
});

test("nothing over cap: no truncation events", () => {
  const env = makeEnv();
  const logs = captureLogs();
  ctx(env.home, ["repo"]);
  logs.stop();
  expect(
    logs.lines.some((l) => l.event === "memory.truncated" || l.event === "memory.repo_skipped"),
  ).toBe(false);
});

test("agent trim logs memory.trimmed with the dropped section count", () => {
  const env = makeEnv();
  const logs = captureLogs();
  for (let i = 0; i < 200; i++)
    appendTaskMemory(env.home, WS, "repo", `t${i}`, {
      bullets: [`lesson ${i}`, `detail ${i}`],
      globalBullets: [],
    });
  logs.stop();
  const t = logs.lines.filter((l) => l.event === "memory.trimmed");
  expect(t.length).toBeGreaterThan(0);
  expect(t[0]).toMatchObject({ level: 40, repo: "repo" });
  expect(t[0]!.droppedSections as number).toBeGreaterThan(0);
});

test("agent append against a live lock logs memory.write_failed (warn) and does not throw", () => {
  const env = makeEnv();
  const f = repoMemoryFile(env.home, WS, "repo");
  writeFileSync(`${f}.lock`, String(process.pid));
  const logs = captureLogs();
  appendTaskMemory(env.home, WS, "repo", "t", { bullets: ["one", "two"], globalBullets: [] });
  logs.stop();
  expect(logs.lines.find((l) => l.event === "memory.write_failed")).toMatchObject({
    level: 40,
    bullets: 2,
  });
}, 15000);
