import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { ensureHome } from "../src/memory/persona";
import { buildPromptContext } from "../src/memory/prompt-context";
import { captureLogs } from "../src/observability/logger";
import { getRole } from "../src/roles/role-registry";
import { buildPromptPreview } from "../src/runtime/prompt-preview/prompt-layers";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { addLocation, makeEnv } from "./helpers";

/** Channel name `addLocation` gives the default `main` workspace. */
const CH = "main-agent";

/** Home with markers in the persona, root memory, channel memory and a (retired) location memory file. */
function setup() {
  const env = makeEnv();
  addLocation(env.home, "api");
  ensureHome(env.home, loadWorkspaces(env.home).workspaces);
  const p = workspacePaths(env.home);
  writeFileSync(p.agents, "# Agents\n- AGENTS_MARK\n");
  writeFileSync(p.memory, "# root memory\n\n## d t\n- ROOT_MARK\n");
  writeFileSync(p.workspace("main").channel(CH).memory, "# ch\n\n## d t\n- CHANNEL_MARK\n");
  return { env, p };
}

test("teammate order: owner files, then TEAM; no memory (user turn), no registry, no ledger; BOOTSTRAP never", () => {
  const { env } = setup();
  const logs = captureLogs();
  const out = buildPromptContext({
    agentHome: env.home,
    workspace: "main",
    channel: CH,
    kind: "teammate",
    team: "TEAM_MARK",
    registry: "REGISTRY_MARK",
    ledger: "LEDGER_MARK",
  });
  logs.stop();
  const all = out.join("\n\n");
  const at = (m: string) => all.indexOf(m);
  expect(at("AGENTS_MARK")).toBeLessThan(at("TEAM_MARK"));
  expect(all).not.toContain("ROOT_MARK"); // the teammate's memory rides in its user turn (teammate-memory.ts)
  expect(all).not.toContain("CHANNEL_MARK");
  expect(all).not.toContain("REGISTRY_MARK");
  expect(all).not.toContain("LEDGER_MARK");
  expect(all).not.toContain("Bootstrap");
  expect(all).not.toContain("# Project Context"); // no legend
  // One size event, counts only.
  const ev = logs.lines.filter((l) => l.event === "prompt.context");
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ personaTruncated: false });
  expect(ev[0]!.memoryRootChars).toBe(0);
  expect(ev[0]!.memoryChannelChars).toBe(0);
  expect(ev[0]).not.toHaveProperty("memoryWorkspaceChars");
  expect(ev[0]).not.toHaveProperty("memoryLocationChars");
  expect(ev[0]!.totalChars).toBe(out.join("").length);
  expect(JSON.stringify(ev[0])).not.toContain("AGENTS_MARK");
});

test("worker: registry, memory (root, channel; read-only), ledger; no persona", () => {
  const { env } = setup();
  const all = buildPromptContext({
    agentHome: env.home,
    workspace: "main",
    channel: CH,
    kind: "worker",
    team: "TEAM_MARK",
    registry: "REGISTRY_MARK",
    ledger: "LEDGER_MARK",
  }).join("\n\n");
  const at = (m: string) => all.indexOf(m);
  expect(at("REGISTRY_MARK")).toBeLessThan(at("ROOT_MARK"));
  expect(at("ROOT_MARK")).toBeLessThan(at("CHANNEL_MARK"));
  expect(at("CHANNEL_MARK")).toBeLessThan(at("LEDGER_MARK"));
  for (const m of ["AGENTS_MARK", "TEAM_MARK"]) expect(all).not.toContain(m);
});

test("worker without a channel: root block only, no channel block", () => {
  const { env } = setup();
  const all = buildPromptContext({ agentHome: env.home, workspace: "main", kind: "worker" }).join(
    "\n\n",
  );
  expect(all).toContain("ROOT_MARK");
  expect(all).not.toContain("### channel");
  expect(all).not.toContain("CHANNEL_MARK");
});

test("empty blocks dropped; no CLAUDE.md fields in the size event", () => {
  const env = makeEnv();
  const logs = captureLogs();
  const out = buildPromptContext({ agentHome: env.home, workspace: "main", kind: "worker" });
  logs.stop();
  expect(out.every(Boolean)).toBe(true);
  const ev = logs.lines.find((l) => l.event === "prompt.context")!;
  expect(ev).toMatchObject({ registryChars: 0 });
  expect(Object.keys(ev).filter((k) => /claudemd/i.test(k))).toEqual([]);
});

test("whole role prompts: every worker kind carries root + channel blocks, never a location block; the teammate and control have none in the system prompt", () => {
  const { env, p } = setup();
  // Retired layers still on disk (workspace and location MEMORY.md) are never read.
  const legacyLocation = join(p.workspace("main").locations, "api");
  mkdirSync(legacyLocation, { recursive: true });
  writeFileSync(join(legacyLocation, "MEMORY.md"), "# api\n\n## d t\n- LOCATION_MARK\n");
  writeFileSync(join(p.workspace("main").root, "MEMORY.md"), "# ws\n\n## d t\n- WSLAYER_MARK\n");
  const prompt = (role: string) =>
    buildPromptPreview(getRole(role), { agentHome: env.home, workspace: "main", channel: CH }).text;
  // developer, scout, one roster specialist (designer).
  for (const role of ["developer", "scout", "designer", "tester"]) {
    const text = prompt(role);
    expect(text).toContain("### root");
    expect(text).toContain(`### channel ${CH}`);
    expect(text).toContain("ROOT_MARK");
    expect(text).toContain("CHANNEL_MARK");
    expect(text).not.toContain("### api");
    expect(text).not.toContain("LOCATION_MARK");
    expect(text).not.toContain("WSLAYER_MARK");
  }
  // The teammate: memory is sent in its user turn on change (teammate-memory.ts), never in the system prompt.
  expect(prompt("chief-of-staff")).not.toContain("ROOT_MARK");
});
