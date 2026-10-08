import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { workspacePaths } from "../src/config/workspace-paths";
import { ensureHome } from "../src/memory/persona";
import { buildPromptContext } from "../src/memory/prompt-context";
import { repoMemoryFile } from "../src/memory/repo-memory";
import { captureLogs } from "../src/observability/logger";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { addRepo, makeEnv } from "./helpers";

/** Home with markers in every layer. */
function setup() {
  const env = makeEnv();
  addRepo(env.home, "api");
  ensureHome(env.home, loadWorkspaces(env.home).workspaces);
  const p = workspacePaths(env.home);
  writeFileSync(p.agents, "# Agents\n- AGENTS_MARK\n");
  writeFileSync(p.memory, "# global memory\n\n## d t\n- ROOT_MARK\n");
  writeFileSync(p.workspace("main").memory, "# main\n\n## d t\n- WSLAYER_MARK\n");
  writeFileSync(repoMemoryFile(env.home, "main", "api"), "# api memory\n\n## d t\n- REPO_MARK\n");
  return { env, p };
}

test("block order: persona, registry, memory (root, workspace, repo); BOOTSTRAP never", () => {
  const { env } = setup();
  const logs = captureLogs();
  const out = buildPromptContext({
    agentHome: env.home,
    workspace: "main",
    registry: "REGISTRY_MARK",
    memoryRepos: ["api"],
  });
  logs.stop();
  const all = out.join("\n\n");
  const at = (m: string) => all.indexOf(m);
  expect(at("AGENTS_MARK")).toBeLessThan(at("REGISTRY_MARK"));
  expect(at("REGISTRY_MARK")).toBeLessThan(at("ROOT_MARK"));
  expect(at("ROOT_MARK")).toBeLessThan(at("WSLAYER_MARK"));
  expect(at("WSLAYER_MARK")).toBeLessThan(at("REPO_MARK"));
  expect(all).not.toContain("Bootstrap");
  // One size event, counts only.
  const ev = logs.lines.filter((l) => l.event === "prompt.context");
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ personaTruncated: false });
  expect(ev[0]!.memoryRootChars as number).toBeGreaterThan(0);
  expect(ev[0]!.totalChars).toBe(out.join("").length);
  expect(JSON.stringify(ev[0])).not.toContain("AGENTS_MARK");
});

test("empty blocks dropped; no CLAUDE.md fields in the size event", () => {
  const { env } = setup();
  const logs = captureLogs();
  const out = buildPromptContext({ agentHome: env.home, workspace: "main", memoryRepos: [] });
  logs.stop();
  expect(out.every(Boolean)).toBe(true);
  const ev = logs.lines.find((l) => l.event === "prompt.context")!;
  expect(ev).toMatchObject({ registryChars: 0 });
  expect(Object.keys(ev).filter((k) => /claudemd/i.test(k))).toEqual([]);
});
