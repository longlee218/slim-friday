import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { captureLogs } from "../src/observability/logger";
import { removeTree } from "../src/runtime/skills-plugin/plugin-copy";
import { sweepStalePlugins } from "../src/runtime/skills-plugin/plugin-sweep";
import { buildRunSkills } from "../src/runtime/skills-plugin/run-skills";

/** The workspace-dir plugin alone (stage without publisher skills), env-independent. */
const workspaceSkills = (workspace: string | undefined, agentHome: string) =>
  buildRunSkills({
    agentHome,
    workspace,
    skills: [],
    subagents: [],
  });

const dirs: string[] = [];
/** A fresh temp agent home. */
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "wsp-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) removeTree(d);
});

/** The skills dir of workspace `main` in `home` (created). */
const skillsDir = (home: string) => {
  const d = workspacePaths(home).workspace("main").skills;
  mkdirSync(d, { recursive: true });
  return d;
};
const skill = (dir: string, name: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
};
const list = (d: string) => (readdirSync(d, { recursive: true }) as string[]).sort();
/** A home whose workspace has `n` skills, each with one file of `bytes` bytes. */
const homeWithSkills = (n: number, bytes = 1) => {
  const home = tmp();
  const sd = skillsDir(home);
  for (let i = 0; i < n; i++) {
    skill(sd, `s${i}`);
    writeFileSync(join(sd, `s${i}`, "f"), Buffer.alloc(bytes));
  }
  return home;
};

test("curated skills: manifest named after the workspace, regular files copied, symlinks skipped", () => {
  const home = tmp();
  const outside = tmp();
  const sd = skillsDir(home);
  skill(sd, "good");
  writeFileSync(join(sd, "good", "helper.sh"), "echo hi\n");
  // A skill that is a symlink to a dir outside, and a symlinked file inside a good skill.
  skill(outside, "evil");
  symlinkSync(join(outside, "evil"), join(sd, "evil"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(sd, "good", "link.txt"));

  const logs = captureLogs();
  const p = workspaceSkills("main", home);
  logs.stop();
  expect(p.plugins).toHaveLength(1);
  const dir = p.plugins![0]!.path;
  expect(p.dirs).toEqual([dir]);
  expect(logs.lines.find((l) => l.event === "skills.plugin_built")).toMatchObject({
    workspace: "main",
    skills: 1,
    files: 3,
  });
  expect(dir.startsWith(join(realpathSync(home), "tmp"))).toBe(true);
  expect(list(dir)).toEqual(
    [
      ".claude-plugin",
      ".claude-plugin/plugin.json",
      "skills",
      "skills/good",
      "skills/good/SKILL.md",
      "skills/good/helper.sh",
    ].sort(),
  );
  expect(JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8"))).toEqual({
    name: "main",
  });
  expect(p.skills).toEqual(["main:good"]);
  p.cleanup();
  expect(existsSync(dir)).toBe(false);
});

test("absent or empty skills dir, no workspace, no plugin and no warning", () => {
  const empty = tmp();
  skillsDir(empty);
  const logs = captureLogs();
  const results = [
    workspaceSkills("main", tmp()),
    workspaceSkills("main", empty),
    workspaceSkills(undefined, tmp()),
  ];
  logs.stop();
  for (const r of results) {
    expect(r.skills).toEqual([]);
    expect(r.plugins).toBeUndefined();
  }
  expect(logs.lines.some((l) => (l.level as number) >= 40)).toBe(false);
  expect(readdirSync(join(empty, "tmp"))).toEqual([]); // the empty case leaves no dir behind
});

test("one bad skill is skipped alone with a warn naming it; the good ones stay", () => {
  const home = homeWithSkills(2); // s0, s1 good
  const sd = skillsDir(home);
  skill(sd, "big");
  for (const n of ["a", "b", "c"]) writeFileSync(join(sd, "big", n), Buffer.alloc(900 * 1024)); // 2.7 MB: over 2 MB per skill
  skill(sd, "fat");
  writeFileSync(join(sd, "fat", "blob"), Buffer.alloc(1024 * 1024 + 1)); // one file over 1 MB
  skill(sd, "many");
  for (let i = 0; i < 101; i++) writeFileSync(join(sd, "many", `f${i}`), "x"); // over 100 entries
  skill(sd, "deep");
  mkdirSync(join(sd, "deep", "1", "2", "3", "4", "5", "6", "7", "8"), { recursive: true });
  const logs = captureLogs();
  const p = workspaceSkills("main", home);
  logs.stop();
  expect(p.skills.sort()).toEqual(["main:s0", "main:s1"]);
  const warns = logs.lines.filter((l) => l.msg === "skill skipped");
  expect(warns.map((w) => [w.skill, w.reason]).sort()).toEqual([
    ["main:big", "too big"],
    ["main:deep", "too deep"],
    ["main:fat", "file too big"],
    ["main:many", "too many entries"],
  ]);
  expect(list(p.plugins![0]!.path).some((f) => /big|fat|many|deep/.test(f))).toBe(false);
  p.cleanup();
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

test("dependency and VCS dirs inside a skill are skipped with a debug log, not an error", () => {
  const home = homeWithSkills(1);
  const sd = skillsDir(home);
  mkdirSync(join(sd, "s0", "node_modules", "dep"), { recursive: true });
  for (let i = 0; i < 400; i++) writeFileSync(join(sd, "s0", "node_modules", `f${i}`), "x");
  mkdirSync(join(sd, "s0", ".git"));
  const logs = captureLogs();
  const p = workspaceSkills("main", home);
  logs.stop();
  expect(p.skills).toEqual(["main:s0"]);
  expect(list(p.plugins![0]!.path).some((f) => /node_modules|.git/.test(f))).toBe(false);
  expect(logs.lines.some((l) => (l.level as number) >= 40)).toBe(false);
  p.cleanup();
});

test("whole-dir total cap is the outer fail-closed limit: nothing loads, warn, nothing left", () => {
  const home = tmp();
  const sd = skillsDir(home);
  for (let i = 0; i < 4; i++) {
    skill(sd, `t${i}`);
    for (let j = 0; j < 90; j++) writeFileSync(join(sd, `t${i}`, `f${j}`), "x"); // 92 each, 368 > 300
  }
  const logs = captureLogs();
  expect(workspaceSkills("main", home).skills).toEqual([]);
  logs.stop();
  expect(logs.lines.some((l) => l.msg === "workspace skills not loaded")).toBe(true);
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

test("total cap 300 entries: 100 skills x (dir + 2 files) fits, 101 does not", () => {
  const ok = workspaceSkills("main", homeWithSkills(100));
  expect(ok.skills).toHaveLength(100);
  ok.cleanup();
  expect(workspaceSkills("main", homeWithSkills(101)).skills).toEqual([]);
});

test("nesting 8 levels inside the skills dir is fine", () => {
  const fine = homeWithSkills(1);
  mkdirSync(join(skillsDir(fine), "s0", "1", "2", "3", "4", "5", "6", "7"), { recursive: true });
  const p = workspaceSkills("main", fine);
  expect(p.skills).toEqual(["main:s0"]);
  p.cleanup();
});

test("qualified name follows the frontmatter name; invalid or missing name falls back to the dir", () => {
  const home = tmp();
  const sd = skillsDir(home);
  const put = (dirName: string, body: string) => {
    mkdirSync(join(sd, dirName));
    writeFileSync(join(sd, dirName, "SKILL.md"), body);
  };
  put("deploy-v2", "---\nname: deploy\ndescription: d\n---\nx\n");
  put("quoted", '---\nname: "fancy"\n---\nx\n');
  put("bad", "---\nname: ../evil name\n---\nx\n");
  put("none", "---\ndescription: d\n---\nx\n");
  put("nofm", "just text\n");
  const logs = captureLogs();
  const p = workspaceSkills("main", home);
  logs.stop();
  expect(p.skills.sort()).toEqual(
    ["main:bad", "main:deploy", "main:fancy", "main:nofm", "main:none"].sort(),
  );
  expect(
    logs.lines.some(
      (l) => l.msg === "skill frontmatter name differs from dir name" && l.dir === "deploy-v2",
    ),
  ).toBe(true);
  p.cleanup();
});

test("a skill dir without SKILL.md is skipped with a debug log", () => {
  const home = tmp();
  const sd = skillsDir(home);
  skill(sd, "ok");
  mkdirSync(join(sd, "empty"));
  writeFileSync(join(sd, "empty", "notes.md"), "x");
  writeFileSync(join(sd, "stray.txt"), "x");
  const logs = captureLogs();
  const p = workspaceSkills("main", home);
  logs.stop();
  expect(p.skills).toEqual(["main:ok"]);
  expect(list(p.plugins![0]!.path).some((f) => f.includes("empty"))).toBe(false);
  expect(
    logs.lines.some(
      (l) => l.msg === "skill dir without SKILL.md skipped" && l.skill === "main:empty",
    ),
  ).toBe(true);
  p.cleanup();
});

test("a skills dir that is a symlink, even to a path inside the workspace, loads nothing and warns", () => {
  const home = tmp();
  const ws = workspacePaths(home).workspace("main");
  const target = join(ws.repos, "r", "repo", ".claude", "skills");
  skill(target, "repo-skill");
  symlinkSync(target, ws.skills);
  const logs = captureLogs();
  const p = workspaceSkills("main", home);
  logs.stop();
  expect(p.skills).toEqual([]);
  expect(p.plugins).toBeUndefined();
  expect(logs.lines.some((l) => (l.level as number) === 40)).toBe(true);
});

test("sweepStalePlugins removes only old plugin-* real dirs directly under <home>/tmp", () => {
  const home = tmp();
  const base = join(home, "tmp");
  const outside = tmp();
  mkdirSync(join(base, "plugin-old"), { recursive: true });
  mkdirSync(join(base, "plugin-new"));
  mkdirSync(join(base, "other-old"));
  symlinkSync(outside, join(base, "plugin-link"));
  writeFileSync(join(outside, "keep"), "x");
  const now = Date.now() + 2 * 60 * 60 * 1000; // two hours later
  const old = new Date(now - 90 * 60 * 1000);
  for (const n of ["plugin-old", "other-old", "plugin-link"]) utimesSync(join(base, n), old, old);
  utimesSync(join(base, "plugin-new"), new Date(now), new Date(now));
  expect(sweepStalePlugins(home, now)).toBe(1);
  expect(existsSync(join(base, "plugin-old"))).toBe(false);
  expect(existsSync(join(base, "plugin-new"))).toBe(true); // younger than 1h relative to the clock
  expect(existsSync(join(base, "other-old"))).toBe(true); // wrong prefix
  expect(existsSync(join(outside, "keep"))).toBe(true); // symlink never followed
  expect(sweepStalePlugins(tmp())).toBe(0); // no tmp dir
});
