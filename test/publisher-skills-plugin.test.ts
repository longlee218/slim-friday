import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { captureLogs } from "../src/observability/logger";
import { ROLES } from "../src/roles/role-registry";
import type { StageDefinition } from "../src/roles/role-types";
import { removeTree } from "../src/runtime/skills-plugin/plugin-copy";
import { PUBLISHER_CAPS } from "../src/runtime/skills-plugin/publisher-skills";
import { buildRunSkills } from "../src/runtime/skills-plugin/run-skills";
import { buildStageSkills } from "../src/runtime/skills-plugin/stage-skills";
import { readSkillsLock, skillDirHash } from "./skills-lock-hash";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pskill-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) removeTree(d);
});

const SDD = "subagent-driven-development";
const DEV = ROLES.dev?.skills ?? [];
const DEV_STAGES = ROLES.dev?.stages ?? [];
/** The subagents of a dev stage today: only the explorer. */
const EXPLORER = ["explorer"];
const DEV_NOW = [
  "brainstorming",
  "executing-plans",
  "systematic-debugging",
  "test-driven-development",
  "verification-before-completion",
  "writing-plans",
];
const GATED = [SDD, "requesting-code-review", "receiving-code-review"];

/** A home whose workspace `main` has the given extra yaml and an empty own skills dir. */
function homeWith(yaml = ""): string {
  const home = tmp();
  const ws = workspacePaths(home).workspace("main");
  mkdirSync(ws.skills, { recursive: true });
  writeFileSync(ws.config, `channels: []\n${yaml}`);
  return home;
}

/** Every regular file under `dir` (relative paths). */
function files(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(dir, join(rel, e.name)) : [join(rel, e.name)],
  );
}

/** Build the run's skills for the dev role with the given subagents (cleanup is the caller's). */
const dev = (home: string, subagents: string[] = EXPLORER) =>
  buildRunSkills({ agentHome: home, workspace: "main", skills: DEV, subagents });

/** A fixture publisher dir: one skill with the given extra files. */
function _fixture(extra: (skillDir: string) => void, name = "alpha"): string {
  const src = join(tmp(), "skills");
  mkdirSync(join(src, name), { recursive: true });
  writeFileSync(join(src, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  extra(join(src, name));
  return src;
}
const _spec = (srcDir: string, allow?: string[]) => ({
  name: "fx",
  kind: "publisher" as const,
  srcDir,
  allow,
  caps: PUBLISHER_CAPS,
});

test("the real publisher plugin lists the six dev skills as superpowers:<name> and copies each skill whole and unmodified", () => {
  const r = dev(homeWith());
  expect([...r.skills].sort()).toEqual(DEV_NOW.map((k) => `superpowers:${k}`));
  const root = r.dirs[0] as string;
  expect(r.scriptDirs).toEqual([root]);
  // Whole: the copy of every role skill (gated ones included) hashes to what skills-lock.json pins.
  const lock = readSkillsLock();
  for (const s of DEV)
    expect([s.name, skillDirHash(join(root, "skills", s.name))]).toEqual([
      s.name,
      lock.skills[s.name]?.computedHash,
    ]);
  // Exec bits kept (task-start/done, the SDD scripts the executing-plans scripts call by relative path).
  for (const rel of [
    "executing-plans/scripts/task-start",
    "executing-plans/scripts/task-done",
    `${SDD}/scripts/task-brief`,
    `${SDD}/scripts/sdd-workspace`,
  ])
    expect(lstatSync(join(root, "skills", rel)).mode & 0o111).not.toBe(0);
  r.cleanup();
  expect(existsSync(root)).toBe(false);
});

test("a gated skill (SDD) is copied for the scripts others call, but not listed until its subagents exist", () => {
  const off = dev(homeWith());
  expect(off.skills).not.toContain(`superpowers:${SDD}`);
  expect(files(off.dirs[0] as string)).toContain(`skills/${SDD}/scripts/task-brief`);
  off.cleanup();
  const on = dev(homeWith(), ["explorer", "implementer", "task-reviewer"]);
  expect(on.skills).toContain(`superpowers:${SDD}`);
  expect(on.skills).toHaveLength(9);
  on.cleanup();
});

test("publisher plugin: only the manifest dir and skills/ at its root (no hooks, .mcp.json, agents, commands, settings)", () => {
  const r = dev(homeWith());
  const root = r.dirs[0] as string;
  expect(readdirSync(root).sort()).toEqual([".claude-plugin", "skills"]);
  expect(readdirSync(join(root, ".claude-plugin"))).toEqual(["plugin.json"]);
  r.cleanup();
});

test("a role with no publisher skills, or a stage without a workspace, gets none", () => {
  const home = homeWith();
  const none = buildRunSkills({ agentHome: home, workspace: "main", skills: [], subagents: [] });
  expect(none.skills).toEqual([]);
  expect(none.plugins).toBeUndefined();
  const noWs = buildRunSkills({
    agentHome: home,
    workspace: undefined,
    skills: DEV,
    subagents: [],
  });
  expect(noWs.skills).toEqual([]);
  // Only gated skills in the role: nothing to list, no plugin built.
  const gatedOnly = buildRunSkills({
    agentHome: home,
    workspace: "main",
    skills: DEV.filter((s) => s.needs),
    subagents: EXPLORER,
  });
  expect(gatedOnly.skills).toEqual([]);
  expect(existsSync(join(home, "tmp")) ? readdirSync(join(home, "tmp")) : []).toEqual([]);
});

test("the workspace dir (extra) gets its own plugin next to the publisher one; script dirs are the publisher's only", () => {
  const home = homeWith();
  const wsSkills = workspacePaths(home).workspace("main").skills;
  mkdirSync(join(wsSkills, "mine"), { recursive: true });
  writeFileSync(join(wsSkills, "mine", "SKILL.md"), "---\nname: mine\ndescription: d\n---\n");
  const r = dev(home);
  expect(r.skills).toContain("main:mine");
  expect(r.skills).toHaveLength(7);
  expect(r.dirs).toHaveLength(2);
  expect(r.plugins).toHaveLength(2);
  expect(r.scriptDirs).toEqual([r.dirs[0] as string]); // a workspace skill's scripts are readable, not auto-run
  r.cleanup();
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
  expect(dev(homeWith("skills:\n  extra: false\n")).skills).toHaveLength(6);
  const only = buildRunSkills({ agentHome: home, workspace: "main", skills: [], subagents: [] });
  expect(only.skills).toEqual(["main:mine"]);
  only.cleanup();
});

test("dev stages: plan loads the six skills, exec also the three subagent skills; a stage outside the registry loads none and warns", () => {
  const names = (st: StageDefinition) => {
    const r = buildStageSkills(st, "main", homeWith());
    r.cleanup();
    return [...r.skills].sort();
  };
  expect(DEV_STAGES.length).toBeGreaterThan(1);
  const plan = DEV_STAGES.find((s) => s.name === "plan") as StageDefinition;
  const exec = DEV_STAGES.find((s) => s.name === "exec") as StageDefinition;
  expect(names(plan)).toEqual(DEV_NOW.map((k) => `superpowers:${k}`));
  expect(names(exec)).toEqual([...DEV_NOW, ...GATED].sort().map((k) => `superpowers:${k}`));
  const logs = captureLogs();
  expect(names({ ...(DEV_STAGES[0] as StageDefinition) })).toEqual([]);
  logs.stop();
  expect(logs.lines.some((l) => l.msg === "stage has no role: no publisher skills loaded")).toBe(
    true,
  );
});
