import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { captureLogs } from "../src/observability/logger";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import { removeTree } from "../src/runtime/skills-plugin/plugin-copy";
import {
  PUBLISHER_CAPS,
  PUBLISHER_SKILLS_DIR,
} from "../src/runtime/skills-plugin/publisher-skills";
import { buildRoleSkills } from "../src/runtime/skills-plugin/role-skills";
import { buildRunSkills } from "../src/runtime/skills-plugin/run-skills";
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

/** Installed publisher skills as the lock lists them (names and plugin come from data, never from this test). */
const LOCK = readSkillsLock();
const INSTALLED = Object.entries(LOCK.skills).map(
  ([name, e]) => `${e.source.split("/").pop()}:${name}`,
);

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

/** Build the run's skills for the dev role (cleanup is the caller's). */
const dev = (home: string) => buildRunSkills({ agentHome: home, workspace: "main", skills: "all" });

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

test("the real publisher plugin lists every locked skill as <plugin>:<name> and copies each skill whole and unmodified", () => {
  expect(INSTALLED.length).toBeGreaterThan(10);
  const r = dev(homeWith());
  expect([...r.skills].sort()).toEqual([...INSTALLED].sort());
  const root = r.dirs[0] as string;
  // Whole: the copy of every skill hashes to what skills-lock.json pins.
  for (const [name, e] of Object.entries(LOCK.skills))
    expect([name, skillDirHash(join(root, "skills", name))]).toEqual([name, e.computedHash]);
  // Exec bits kept: every file of the copy has the exec bits of its source, and some scripts are executable.
  const copied = files(root).filter((f) => f.startsWith("skills/"));
  let executable = 0;
  for (const rel of copied) {
    const bits = lstatSync(join(root, rel)).mode & 0o111;
    expect([rel, bits]).toEqual([
      rel,
      lstatSync(join(PUBLISHER_SKILLS_DIR, rel.slice(7))).mode & 0o111,
    ]);
    if (bits) executable++;
  }
  expect(executable).toBeGreaterThan(0);
  r.cleanup();
  expect(existsSync(root)).toBe(false);
});

test("a new skill in a publisher dir (dir + lock entry) is listed for dev with no code change", () => {
  const src = join(tmp(), "skills");
  const newSkill = "brand-new-skill";
  mkdirSync(join(src, newSkill), { recursive: true });
  writeFileSync(
    join(src, newSkill, "SKILL.md"),
    `---\nname: ${newSkill}\ndescription: d\n---\nb\n`,
  );
  // A second publisher: its own plugin, named by the last segment of its source.
  const other = "other-skill";
  mkdirSync(join(src, other), { recursive: true });
  writeFileSync(join(src, other, "SKILL.md"), `---\nname: ${other}\ndescription: d\n---\nb\n`);
  const lockFile = join(tmp(), "skills-lock.json");
  writeFileSync(
    lockFile,
    JSON.stringify({
      version: 1,
      skills: {
        [newSkill]: { source: "acme/toolkit" },
        [other]: { source: "someone/else-pack" },
        "locked-but-missing": { source: "acme/toolkit" }, // no dir: warned, left out
      },
    }),
  );
  const logs = captureLogs();
  const r = buildRunSkills({
    agentHome: homeWith(),
    workspace: "main",
    skills: "all",
    publisherDir: src,
    lockFile,
  });
  logs.stop();
  expect([...r.skills].sort()).toEqual(["else-pack:other-skill", "toolkit:brand-new-skill"]);
  expect(r.plugins).toHaveLength(2); // one plugin per source; the workspace dir has no skills
  expect(logs.lines.some((l) => l.msg === "skill is in the lock but not on disk")).toBe(true);
  r.cleanup();
  // The same dir for a role with `none`: nothing loads.
  const none = buildRunSkills({
    agentHome: homeWith(),
    workspace: "main",
    skills: "none",
    publisherDir: src,
    lockFile,
  });
  expect(none.skills).toEqual([]);
});

test("a dir the lock does not list is never loaded", () => {
  const src = join(tmp(), "skills");
  mkdirSync(join(src, "unlisted"), { recursive: true });
  writeFileSync(join(src, "unlisted", "SKILL.md"), "---\nname: unlisted\ndescription: d\n---\n");
  const lockFile = join(tmp(), "skills-lock.json");
  writeFileSync(lockFile, JSON.stringify({ version: 1, skills: {} }));
  const r = buildRunSkills({
    agentHome: homeWith(),
    workspace: "main",
    skills: "all",
    publisherDir: src,
    lockFile,
  });
  expect(r.skills).toEqual([]);
});

test("publisher plugin: only the manifest dir and skills/ at its root (no hooks, .mcp.json, agents, commands, settings)", () => {
  const r = dev(homeWith());
  const root = r.dirs[0] as string;
  expect(readdirSync(root).sort()).toEqual([".claude-plugin", "skills"]);
  expect(readdirSync(join(root, ".claude-plugin"))).toEqual(["plugin.json"]);
  r.cleanup();
});

test("a role with `none`, or a stage without a workspace, gets no publisher skills", () => {
  const home = homeWith();
  const none = buildRunSkills({ agentHome: home, workspace: "main", skills: "none" });
  expect(none.skills).toEqual([]);
  expect(none.plugins).toBeUndefined();
  const noWs = buildRunSkills({ agentHome: home, workspace: undefined, skills: "all" });
  expect(noWs.skills).toEqual([]);
  expect(existsSync(join(home, "tmp")) ? readdirSync(join(home, "tmp")) : []).toEqual([]);
});

test("the workspace dir (extra) gets its own plugin next to the publisher one; script dirs are the publisher's only", () => {
  const home = homeWith();
  const wsSkills = workspacePaths(home).workspace("main").skills;
  mkdirSync(join(wsSkills, "mine"), { recursive: true });
  writeFileSync(join(wsSkills, "mine", "SKILL.md"), "---\nname: mine\ndescription: d\n---\n");
  const r = dev(home);
  expect(r.skills).toContain("main:mine");
  expect(r.skills).toHaveLength(INSTALLED.length + 1);
  expect(r.dirs).toHaveLength(2);
  expect(r.plugins).toHaveLength(2);
  r.cleanup();
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
  expect(dev(homeWith("skills:\n  extra: false\n")).skills).toHaveLength(INSTALLED.length);
  const only = buildRunSkills({ agentHome: home, workspace: "main", skills: "none" });
  expect(only.skills).toEqual(["main:mine"]);
  only.cleanup();
});

test("dev loads every installed skill, the lead none; a role without `skills` loads none", () => {
  const names = (role: RoleDefinition) => {
    const r = buildRoleSkills(role, "main", homeWith());
    r.cleanup();
    return [...r.skills].sort();
  };
  expect(names(ROLES.developer as RoleDefinition)).toEqual([...INSTALLED].sort());
  expect(names(ROLES.lead as RoleDefinition)).toEqual([]);
  expect(names({ ...(ROLES.developer as RoleDefinition), skills: undefined })).toEqual([]);
});
