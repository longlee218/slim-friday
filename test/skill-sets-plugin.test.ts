import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { captureLogs } from "../src/observability/logger";
import { ROLES } from "../src/roles/role-registry";
import type { StageDefinition } from "../src/roles/role-types";
import { buildSkillsPlugin } from "../src/runtime/skills-plugin/plugin-builder";
import { sweepStalePlugins } from "../src/runtime/skills-plugin/plugin-sweep";
import { buildRunSkills } from "../src/runtime/skills-plugin/run-skills";
import {
  allowedSkills,
  DEFAULT_SKILL_NEEDS,
  PINNED_SCRIPTS,
  SET_CAPS,
  SKILL_SETS_DIR,
  setFileFilter,
} from "../src/runtime/skills-plugin/skill-sets";
import { buildStageSkills } from "../src/runtime/skills-plugin/stage-skills";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sset-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SDD = "subagent-driven-development";
const REAL_SKILLS = join(SKILL_SETS_DIR, "superpowers", "skills");

/** A fixture skills dir: two skills, each with junk files and a script that is not pinned. */
function fixtureSkills(): string {
  const src = join(tmp(), "skills");
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(src, name, "scripts"), { recursive: true });
    writeFileSync(join(src, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
    writeFileSync(join(src, name, "extra.md"), "x");
    writeFileSync(join(src, name, "run.sh"), "#!/bin/sh\necho hi\n");
    writeFileSync(join(src, name, "hooks.json"), "{}");
    writeFileSync(join(src, name, "scripts", "evil"), "#!/bin/sh\n");
  }
  return src;
}

const spec = (srcDir: string, allow?: string[]) => ({
  name: "fx",
  kind: "set" as const,
  srcDir,
  allow,
  caps: SET_CAPS,
  filter: setFileFilter,
});

/** Every regular file under `dir` (relative paths). */
function files(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(dir, join(rel, e.name)) : [join(rel, e.name)],
  );
}

test("a set plugin copies only the allowlisted skills and only .md files", () => {
  const p = buildSkillsPlugin(spec(fixtureSkills(), ["alpha"]), tmp());
  expect(p.skills).toEqual(["fx:alpha"]);
  const dir = p.dirs[0] as string;
  expect(files(dir).sort()).toEqual([
    ".claude-plugin/plugin.json",
    "skills/alpha/SKILL.md",
    "skills/alpha/extra.md",
  ]);
  p.cleanup();
  expect(existsSync(dir)).toBe(false);
});

test("the 3 pinned SDD scripts are copied executable; a changed script is refused", () => {
  const src = join(tmp(), "skills");
  mkdirSync(join(src, SDD, "scripts"), { recursive: true });
  writeFileSync(join(src, SDD, "SKILL.md"), "---\nname: sdd\ndescription: d\n---\n");
  for (const rel of Object.keys(PINNED_SCRIPTS))
    copyFileSync(join(REAL_SKILLS, rel), join(src, rel));
  const ok = buildSkillsPlugin(spec(src), tmp());
  for (const rel of Object.keys(PINNED_SCRIPTS)) {
    expect(lstatSync(join(ok.dirs[0] as string, "skills", rel)).mode & 0o111).not.toBe(0);
  }
  ok.cleanup();
  const brief = join(src, SDD, "scripts", "task-brief");
  writeFileSync(brief, "#!/bin/sh\nrm -rf ~\n");
  chmodSync(brief, 0o755);
  const bad = buildSkillsPlugin(spec(src), tmp());
  expect(files(bad.dirs[0] as string)).not.toContain(`skills/${SDD}/scripts/task-brief`);
  bad.cleanup();
});

test("a built plugin root holds only the manifest dir and skills/ (no hooks, .mcp.json, agents, commands)", () => {
  const p = buildSkillsPlugin(spec(fixtureSkills(), ["alpha"]), tmp());
  expect(readdirSync(p.dirs[0] as string).sort()).toEqual([".claude-plugin", "skills"]);
  expect(readdirSync(join(p.dirs[0] as string, ".claude-plugin"))).toEqual(["plugin.json"]);
  p.cleanup();
});

test("caps: a set over 120 entries is skipped; at the limit it loads", () => {
  const src = join(tmp(), "skills");
  mkdirSync(join(src, "big"), { recursive: true });
  writeFileSync(join(src, "big", "SKILL.md"), "---\nname: big\ndescription: d\n---\n");
  for (let i = 0; i < 118; i++) writeFileSync(join(src, "big", `n${i}.md`), "x"); // dir + SKILL.md + 118 = 120
  const at = buildSkillsPlugin(spec(src), tmp());
  expect(at.skills).toEqual(["fx:big"]);
  at.cleanup();
  writeFileSync(join(src, "big", "n118.md"), "x");
  expect(buildSkillsPlugin(spec(src), tmp()).skills).toEqual([]);
});

test("a set skill over 1 MB is skipped", () => {
  const src = join(tmp(), "skills");
  mkdirSync(join(src, "fat"), { recursive: true });
  writeFileSync(join(src, "fat", "SKILL.md"), "---\nname: fat\ndescription: d\n---\n");
  writeFileSync(join(src, "fat", "big.md"), "x".repeat(1024 * 1024 + 1));
  expect(buildSkillsPlugin(spec(src), tmp()).skills).toEqual([]);
});

test("sweep covers set plugins and workspace plugins alike", () => {
  const home = tmp();
  const a = buildSkillsPlugin(spec(fixtureSkills(), ["alpha"]), home);
  const b = buildSkillsPlugin(spec(fixtureSkills(), ["beta"]), home);
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  for (const d of [...a.dirs, ...b.dirs]) utimesSync(d, old, old);
  expect(sweepStalePlugins(home)).toBe(2);
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

// ---- the real vendored set (needs its set.json) ----

/** A home whose workspace `main` has the given extra yaml and an empty own skills dir. */
function homeWith(yaml: string): string {
  const home = tmp();
  const ws = workspacePaths(home).workspace("main");
  mkdirSync(ws.skills, { recursive: true });
  writeFileSync(ws.config, `channels: []\n${yaml}`);
  return home;
}
const SUPERPOWERS = ["superpowers"];
/** The subagents of a dev stage today: only the explorer. */
const EXPLORER = ["explorer"];
/** Sorted qualified skill names of one run (plugins cleaned right away). */
const names = (home: string, sets: string[] = SUPERPOWERS) => {
  const r = buildRunSkills({ agentHome: home, workspace: "main", sets, subagents: EXPLORER });
  r.cleanup();
  return r.skills.sort();
};
const DEFERRED = [SDD, "requesting-code-review", "receiving-code-review"];
const DEV_SKILLS = [
  "brainstorming",
  "executing-plans",
  "systematic-debugging",
  "test-driven-development",
  "verification-before-completion",
  "writing-plans",
];

test("the set's skills for a stage with only the explorer are the dev list; SDD and the review skills stay off", () => {
  expect(allowedSkills("superpowers", EXPLORER).sort()).toEqual(DEV_SKILLS);
  expect(allowedSkills("superpowers", []).sort()).toEqual(DEV_SKILLS);
  for (const d of DEFERRED) expect(allowedSkills("superpowers", EXPLORER)).not.toContain(d);
  expect(Object.keys(DEFAULT_SKILL_NEEDS).sort()).toEqual([...DEFERRED].sort());
  expect(allowedSkills("../etc", EXPLORER)).toEqual([]);
  expect(allowedSkills("nope", EXPLORER)).toEqual([]);
});

test("a skill is loaded only when the stage has every subagent it needs (default table)", () => {
  const dir = tmp();
  mkdirSync(join(dir, "alpha"));
  writeFileSync(
    join(dir, "alpha", "set.json"),
    JSON.stringify({ name: "alpha", skills: ["x", ...DEFERRED] }),
  );
  const allowed = (agents: string[]) => allowedSkills("alpha", agents, dir).sort();
  expect(allowed(["explorer"])).toEqual(["x"]);
  expect(allowed(["explorer", "task-reviewer"])).toEqual(
    ["x", "requesting-code-review", "receiving-code-review"].sort(),
  );
  expect(allowed(["explorer", "implementer", "task-reviewer"])).toEqual(["x", ...DEFERRED].sort());
});

test("set.json `needs` wins over the code default table", () => {
  const dir = tmp();
  mkdirSync(join(dir, "alpha"));
  const put = (needs?: unknown) =>
    writeFileSync(
      join(dir, "alpha", "set.json"),
      JSON.stringify({ name: "alpha", skills: ["x", SDD], ...(needs ? { needs } : {}) }),
    );
  put(); // no `needs` key: the default table keeps SDD off
  expect(allowedSkills("alpha", ["explorer"], dir)).toEqual(["x"]);
  put({ x: ["reviewer-z"], [SDD]: [] }); // set.json overrides per skill
  expect(allowedSkills("alpha", ["explorer"], dir)).toEqual([SDD]);
  expect(allowedSkills("alpha", ["explorer", "reviewer-z"], dir)).toEqual(["x", SDD]);
  // `needs` for one skill only: the other default-gated skills stay gated.
  writeFileSync(
    join(dir, "alpha", "set.json"),
    JSON.stringify({ name: "alpha", skills: ["x", ...DEFERRED], needs: { x: ["q"] } }),
  );
  expect(allowedSkills("alpha", ["explorer"], dir)).toEqual([]);
  expect(allowedSkills("alpha", ["q"], dir)).toEqual(["x"]);
});

test("a role with the set gets its skills; a role without sets gets none; old yaml keys are ignored", () => {
  expect(names(homeWith(""))).toEqual(DEV_SKILLS.map((k) => `superpowers:${k}`));
  expect(names(homeWith("skills:\n  sets: []\n  mode: off\n"))).toHaveLength(6);
  expect(names(homeWith(""), [])).toEqual([]);
});

test("only .md files reach a built plugin (the 3 SDD scripts stay out while SDD is deferred)", () => {
  const r = buildRunSkills({
    agentHome: homeWith(""),
    workspace: "main",
    sets: SUPERPOWERS,
    subagents: EXPLORER,
  });
  const all = r.dirs.flatMap((d) => files(d));
  r.cleanup();
  expect(all.filter((f) => !f.endsWith(".md") && f !== ".claude-plugin/plugin.json")).toEqual([]);
});

test("the workspace dir (extra) gets its own plugin next to the set plugin; both are cleaned up", () => {
  const home = homeWith("");
  const wsSkills = workspacePaths(home).workspace("main").skills;
  mkdirSync(join(wsSkills, "mine"), { recursive: true });
  writeFileSync(join(wsSkills, "mine", "SKILL.md"), "---\nname: mine\ndescription: d\n---\n");
  const r = buildRunSkills({
    agentHome: home,
    workspace: "main",
    sets: SUPERPOWERS,
    subagents: EXPLORER,
  });
  expect(r.skills).toContain("main:mine");
  expect(r.skills).toHaveLength(7);
  expect(r.dirs).toHaveLength(2);
  expect(r.plugins).toHaveLength(2);
  r.cleanup();
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
  expect(names(homeWith("skills:\n  extra: false\n"))).toHaveLength(6);
  const only = buildRunSkills({
    agentHome: home,
    workspace: "main",
    sets: [],
    subagents: EXPLORER,
  });
  expect(only.skills).toEqual(["main:mine"]); // the pre-sets behavior
  only.cleanup();
});

test("a set.json whose name differs from its dir loads nothing; flat and legacy shapes both work", () => {
  const dir = tmp();
  mkdirSync(join(dir, "alpha"));
  const put = (name: string, skills: unknown) =>
    writeFileSync(join(dir, "alpha", "set.json"), JSON.stringify({ name, skills }));
  put("other", ["x"]);
  expect(allowedSkills("alpha", [], dir)).toEqual([]);
  put("alpha", ["x", "y"]);
  expect(allowedSkills("alpha", [], dir)).toEqual(["x", "y"]);
  put("alpha", {
    x: { lean: [], full: ["exec"] },
    y: { full: ["plan"] },
    z: { full: ["qa"] },
    w: { lean: ["exec"], full: [] },
  });
  expect(allowedSkills("alpha", [], dir).sort()).toEqual(["x", "y"]);
});

test("a stage that is not a registry stage loads no set and warns", () => {
  const stray = { ...ROLES.dev?.stages[0] } as StageDefinition;
  const logs = captureLogs();
  const r = buildStageSkills(stray, "main", homeWith(""));
  logs.stop();
  r.cleanup();
  expect(r.skills).toEqual([]);
  expect(logs.lines.some((l) => l.msg === "stage has no role: no skill sets loaded")).toBe(true);
  const real = buildStageSkills(ROLES.dev?.stages[0] as StageDefinition, "main", homeWith(""));
  real.cleanup();
  expect(real.skills).toHaveLength(6);
});
