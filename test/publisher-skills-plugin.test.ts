import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { captureLogs } from "../src/observability/logger";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import { removeTree } from "../src/runtime/skills-plugin/plugin-copy";
import { PUBLISHER_SKILLS_DIR } from "../src/runtime/skills-plugin/publisher-skills";
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
/** The developer's set: every locked skill except the friday source (the other roles' own skills). */
const PUBLISHER = Object.entries(LOCK.skills).filter(([, e]) => !e.source.endsWith("/friday"));
const INSTALLED = PUBLISHER.map(([name, e]) => `${e.source.split("/").pop()}:${name}`);
/** One plugin per publisher source. */
const PLUGINS = new Set(PUBLISHER.map(([, e]) => e.source)).size;
/** The developer's set: every skill of each publisher source it uses (a whole pack, so none is missed). */
const devSources = new Set(
  PUBLISHER.filter(([n]) => ROLES.developer?.skills?.includes(n)).map(([, e]) => e.source),
);
const DEV_INSTALLED = PUBLISHER.filter(([, e]) => devSources.has(e.source)).map(
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

/** Build the run's skills with every locked skill listed (cleanup is the caller's). */
const dev = (home: string) =>
  buildRunSkills({ agentHome: home, workspace: "main", skills: PUBLISHER.map(([n]) => n) });

test("the real publisher plugin lists every locked skill as <plugin>:<name> and copies each skill whole and unmodified", () => {
  expect(INSTALLED.length).toBeGreaterThan(10);
  const r = dev(homeWith());
  expect([...r.skills].sort()).toEqual([...INSTALLED].sort());
  // One plugin dir per publisher source; a skill lives in the dir of its own plugin.
  expect(r.dirs).toHaveLength(PLUGINS);
  const rootOf = (name: string) =>
    r.dirs.find((d) => existsSync(join(d, "skills", name))) as string;
  // Whole: the copy of every skill hashes to what skills-lock.json pins.
  for (const [name, e] of PUBLISHER)
    expect([name, skillDirHash(join(rootOf(name), "skills", name))]).toEqual([
      name,
      e.computedHash,
    ]);
  // Exec bits kept: every file of the copy has the exec bits of its source, and some scripts are executable.
  let executable = 0;
  for (const root of r.dirs)
    for (const rel of files(root).filter((f) => f.startsWith("skills/"))) {
      const bits = lstatSync(join(root, rel)).mode & 0o111;
      expect([rel, bits]).toEqual([
        rel,
        lstatSync(join(PUBLISHER_SKILLS_DIR, rel.slice(7))).mode & 0o111,
      ]);
      if (bits) executable++;
    }
  expect(executable).toBeGreaterThan(0);
  r.cleanup();
  for (const root of r.dirs) expect(existsSync(root)).toBe(false);
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
    skills: [newSkill, other, "locked-but-missing"],
    publisherDir: src,
    lockFile,
  });
  logs.stop();
  expect([...r.skills].sort()).toEqual(["else-pack:other-skill", "toolkit:brand-new-skill"]);
  expect(r.plugins).toHaveLength(2); // one plugin per source; the workspace dir has no skills
  expect(logs.lines.some((l) => l.msg === "skill is in the lock but not on disk")).toBe(true);
  r.cleanup();
  // The same dir for a role with `[]`: nothing loads.
  const none = buildRunSkills({
    agentHome: homeWith(),
    workspace: "main",
    skills: [],
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
    skills: ["unlisted"],
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

test("a role with `[]` gets no publisher skills; a run without a workspace still gets the listed ones, no workspace dir", () => {
  const home = homeWith();
  const none = buildRunSkills({ agentHome: home, workspace: "main", skills: [] });
  expect(none.skills).toEqual([]);
  expect(none.plugins).toBeUndefined();
  const noWsNone = buildRunSkills({ agentHome: home, workspace: undefined, skills: [] });
  expect(noWsNone.skills).toEqual([]);
  const noWs = buildRunSkills({ agentHome: home, workspace: undefined, skills: ["scout"] });
  expect(noWs.skills).toEqual(["friday:scout"]);
  noWs.cleanup();
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
  expect(r.dirs).toHaveLength(PLUGINS + 1);
  expect(r.plugins).toHaveLength(PLUGINS + 1);
  r.cleanup();
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
  expect(dev(homeWith("skills:\n  extra: false\n")).skills).toHaveLength(INSTALLED.length);
  const only = buildRunSkills({ agentHome: home, workspace: "main", skills: [] });
  expect(only.skills).toEqual(["main:mine"]);
  only.cleanup();
});

test("dev loads every skill of its publisher packs, the lead none; a role without `skills` loads none", () => {
  const names = (role: RoleDefinition) => {
    const r = buildRoleSkills(role, "main", homeWith());
    r.cleanup();
    return [...r.skills].sort();
  };
  expect(names(ROLES.developer as RoleDefinition)).toEqual([...DEV_INSTALLED].sort());
  expect(names(ROLES.lead as RoleDefinition)).toEqual([]);
  expect(names({ ...(ROLES.developer as RoleDefinition), skills: undefined })).toEqual([]);
});
