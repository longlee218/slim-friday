import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { ensureHome } from "../src/memory/persona";
import { buildPromptContext } from "../src/memory/prompt-context";
import { memoryFile } from "../src/memory/repo-memory";
import { captureLogs } from "../src/observability/logger";
import { makeEnv } from "./helpers";

/** Home with markers in every layer. */
function setup() {
  const env = makeEnv();
  ensureHome(env.home, []);
  const p = workspacePaths(env.home);
  writeFileSync(p.agents, "# Agents\n- AGENTS_MARK\n");
  writeFileSync(p.memory, "# global memory\n\n## d t\n- ROOT_MARK\n");
  mkdirSync(join(env.home, "workspaces", "api"), { recursive: true });
  writeFileSync(memoryFile(env.home, "api"), "# api memory\n\n## d t\n- WS_MARK\n");
  return { env, p };
}

test("block order: persona, registry, repo CLAUDE.md, memory (root then workspace); BOOTSTRAP never", () => {
  const { env } = setup();
  const logs = captureLogs();
  const out = buildPromptContext({
    agentHome: env.home,
    workspace: "api",
    registry: "REGISTRY_MARK",
    repoClaudeMd: "CLAUDE_MARK",
    memoryWorkspaces: ["api"],
  });
  logs.stop();
  const all = out.join("\n\n");
  const at = (m: string) => all.indexOf(m);
  expect(at("AGENTS_MARK")).toBeLessThan(at("REGISTRY_MARK"));
  expect(at("REGISTRY_MARK")).toBeLessThan(at("CLAUDE_MARK"));
  expect(at("CLAUDE_MARK")).toBeLessThan(at("ROOT_MARK"));
  expect(at("ROOT_MARK")).toBeLessThan(at("WS_MARK"));
  expect(all).not.toContain("Bootstrap");
  // One size event, counts only.
  const ev = logs.lines.filter((l) => l.event === "prompt.context");
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ personaTruncated: false, claudeMdChars: 11 });
  expect(ev[0]!.memoryRootChars as number).toBeGreaterThan(0);
  expect(ev[0]!.totalChars).toBe(out.join("").length);
  expect(JSON.stringify(ev[0])).not.toContain("AGENTS_MARK");
});

test("sdkCwd CLAUDE.md is measured; empty blocks dropped", () => {
  const { env } = setup();
  const cwd = join(env.home, "cwd");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "CLAUDE.md"), "12345");
  const logs = captureLogs();
  const out = buildPromptContext({ agentHome: env.home, memoryWorkspaces: [], sdkCwd: cwd });
  logs.stop();
  expect(out.every(Boolean)).toBe(true);
  expect(logs.lines.find((l) => l.event === "prompt.context")).toMatchObject({
    sdkCwdClaudeMdChars: 5,
    registryChars: 0,
  });
});
