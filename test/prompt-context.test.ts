import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { workspacePaths } from "../src/config/workspace-paths";
import { locationMemoryFile } from "../src/memory/location-memory";
import { ensureHome } from "../src/memory/persona";
import { buildPromptContext } from "../src/memory/prompt-context";
import { captureLogs } from "../src/observability/logger";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { addLocation, makeEnv } from "./helpers";

/** Home with markers in every layer. */
function setup() {
  const env = makeEnv();
  addLocation(env.home, "api");
  ensureHome(env.home, loadWorkspaces(env.home).workspaces);
  const p = workspacePaths(env.home);
  writeFileSync(p.agents, "# Agents\n- AGENTS_MARK\n");
  writeFileSync(p.memory, "# global memory\n\n## d t\n- ROOT_MARK\n");
  writeFileSync(p.workspace("main").memory, "# main\n\n## d t\n- WSLAYER_MARK\n");
  writeFileSync(
    locationMemoryFile(env.home, "main", "api"),
    "# api memory\n\n## d t\n- LOCATION_MARK\n",
  );
  return { env, p };
}

test("lead order: TEAM, AGENTS, persona, memory (root, workspace, location); no registry, no ledger; BOOTSTRAP never", () => {
  const { env } = setup();
  const logs = captureLogs();
  const out = buildPromptContext({
    agentHome: env.home,
    workspace: "main",
    kind: "lead",
    team: "TEAM_MARK",
    registry: "REGISTRY_MARK",
    ledger: "LEDGER_MARK",
    memoryLocations: ["api"],
  });
  logs.stop();
  const all = out.join("\n\n");
  const at = (m: string) => all.indexOf(m);
  expect(at("TEAM_MARK")).toBeLessThan(at("AGENTS_MARK"));
  expect(at("AGENTS_MARK")).toBeLessThan(at("ROOT_MARK"));
  expect(at("ROOT_MARK")).toBeLessThan(at("WSLAYER_MARK"));
  expect(at("WSLAYER_MARK")).toBeLessThan(at("LOCATION_MARK"));
  expect(all).not.toContain("REGISTRY_MARK");
  expect(all).not.toContain("LEDGER_MARK");
  expect(all).not.toContain("Bootstrap");
  expect(all).not.toContain("# Project Context"); // no legend
  // One size event, counts only.
  const ev = logs.lines.filter((l) => l.event === "prompt.context");
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ personaTruncated: false });
  expect(ev[0]!.memoryRootChars as number).toBeGreaterThan(0);
  expect(ev[0]!.totalChars).toBe(out.join("").length);
  expect(JSON.stringify(ev[0])).not.toContain("AGENTS_MARK");
});

test("worker: registry, its location memory, ledger; no persona, no root or workspace memory", () => {
  const { env } = setup();
  const all = buildPromptContext({
    agentHome: env.home,
    workspace: "main",
    kind: "worker",
    team: "TEAM_MARK",
    registry: "REGISTRY_MARK",
    ledger: "LEDGER_MARK",
    memoryLocations: ["api"],
  }).join("\n\n");
  const at = (m: string) => all.indexOf(m);
  expect(at("REGISTRY_MARK")).toBeLessThan(at("LOCATION_MARK"));
  expect(at("LOCATION_MARK")).toBeLessThan(at("LEDGER_MARK"));
  for (const m of ["AGENTS_MARK", "TEAM_MARK", "ROOT_MARK", "WSLAYER_MARK"])
    expect(all).not.toContain(m);
});

test("empty blocks dropped; no CLAUDE.md fields in the size event", () => {
  const { env } = setup();
  const logs = captureLogs();
  const out = buildPromptContext({
    agentHome: env.home,
    workspace: "main",
    kind: "worker",
    memoryLocations: [],
  });
  logs.stop();
  expect(out.every(Boolean)).toBe(true);
  const ev = logs.lines.find((l) => l.event === "prompt.context")!;
  expect(ev).toMatchObject({ registryChars: 0 });
  expect(Object.keys(ev).filter((k) => /claudemd/i.test(k))).toEqual([]);
});
