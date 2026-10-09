import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStalePlugins, workspaceSkills } from "../src/agent/workspace-skills-plugin";
import { workspacePaths } from "../src/config/workspace-paths";
import { captureLogs } from "../src/observability/logger";

const dirs: string[] = [];
/** A fresh temp agent home. */
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "wsp-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
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

test("absent or empty skills dir, no workspace, or a dir symlinked out: no plugin and no warning", () => {
  const outside = tmp();
  skill(outside, "evil");
  const linked = tmp();
  mkdirSync(workspacePaths(linked).workspace("main").root, { recursive: true });
  symlinkSync(outside, workspacePaths(linked).workspace("main").skills);
  const empty = tmp();
  skillsDir(empty);
  const logs = captureLogs();
  const results = [
    workspaceSkills("main", tmp()),
    workspaceSkills("main", empty),
    workspaceSkills("main", linked),
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

test("oversized skills fail closed: no plugin, warn, nothing left behind", () => {
  const home = homeWithSkills(1, 6 * 1024 * 1024);
  const logs = captureLogs();
  expect(workspaceSkills("main", home)).toMatchObject({ skills: [] });
  logs.stop();
  expect(logs.lines.some((l) => l.level === 40 && l.msg === "workspace skills not loaded")).toBe(
    true,
  );
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

test("cap 300 entries (files + dirs): 100 skills x (dir + 2 files) fits, 101 does not", () => {
  const ok = workspaceSkills("main", homeWithSkills(100));
  expect(ok.skills).toHaveLength(100);
  ok.cleanup();
  expect(workspaceSkills("main", homeWithSkills(101)).skills).toEqual([]);
});

test("empty directories count against the cap, and nesting deeper than 8 is refused", () => {
  const bomb = homeWithSkills(1);
  for (let i = 0; i < 301; i++) mkdirSync(join(skillsDir(bomb), "s0", `e${i}`));
  const deep = homeWithSkills(1);
  mkdirSync(join(skillsDir(deep), "s0", "1", "2", "3", "4", "5", "6", "7", "8"), {
    recursive: true,
  });
  const fine = homeWithSkills(1);
  mkdirSync(join(skillsDir(fine), "s0", "1", "2", "3", "4", "5", "6", "7"), { recursive: true });
  const logs = captureLogs();
  expect(workspaceSkills("main", bomb).skills).toEqual([]);
  expect(workspaceSkills("main", deep).skills).toEqual([]);
  const ok = workspaceSkills("main", fine);
  logs.stop();
  expect(ok.skills).toEqual(["main:s0"]);
  expect(logs.lines.filter((l) => l.msg === "workspace skills not loaded")).toHaveLength(2);
  ok.cleanup();
  expect(readdirSync(join(fine, "tmp"))).toEqual([]);
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
