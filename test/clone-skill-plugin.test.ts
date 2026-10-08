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
import { runSkills, sweepStalePlugins } from "../src/agent/clone-skill-plugin";
import { captureLogs } from "../src/observability/logger";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "csp-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const skill = (dir: string, name: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
};
const list = (d: string) => (readdirSync(d, { recursive: true }) as string[]).sort();

test("hostile clone .claude: only the manifest and the regular skills are copied", () => {
  const clone = tmp();
  const home = tmp();
  const outside = tmp();
  const claude = join(clone, ".claude");
  skill(join(claude, "skills"), "good");
  writeFileSync(join(claude, "skills", "good", "helper.sh"), "echo hi\n");
  // Everything a plugin could use to run code or widen the agent: none of it may reach the plugin dir.
  mkdirSync(join(claude, "hooks"));
  writeFileSync(join(claude, "hooks", "hooks.json"), '{"hooks":{"PreToolUse":[]}}');
  writeFileSync(join(claude, ".mcp.json"), '{"mcpServers":{"x":{"command":"touch"}}}');
  writeFileSync(join(claude, "settings.json"), "{}");
  writeFileSync(join(claude, "settings.local.json"), "{}");
  mkdirSync(join(claude, "agents"));
  writeFileSync(join(claude, "agents", "a.md"), "agent");
  mkdirSync(join(claude, "commands"));
  writeFileSync(join(claude, "commands", "c.md"), "cmd");
  // A skill that is a symlink to a dir outside the clone, and a symlinked file inside a good skill.
  skill(outside, "evil");
  symlinkSync(join(outside, "evil"), join(claude, "skills", "evil"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(claude, "skills", "good", "link.txt"));

  const logs = captureLogs();
  const p = runSkills([{ name: "my repo!", path: clone }], home);
  logs.stop();
  expect(p.plugins).toHaveLength(1);
  const dir = p.plugins![0]!.path;
  expect(logs.lines.find((l) => l.event === "skills.plugin_built")).toMatchObject({
    repos: ["my repo!"],
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
    name: "my-repo-",
  });
  expect(p.skills).toEqual(["my-repo-:good"]);
  p.cleanup();
  expect(existsSync(dir)).toBe(false);
});

test("skills dir symlinked out of the clone, or no skills: no plugin", () => {
  const clone = tmp();
  const outside = tmp();
  skill(join(outside, "skills"), "evil");
  mkdirSync(join(clone, ".claude"));
  symlinkSync(join(outside, "skills"), join(clone, ".claude", "skills"));
  for (const r of [
    runSkills([{ name: "a", path: clone }], tmp()),
    runSkills([{ name: "b", path: tmp() }], tmp()),
    runSkills(undefined, tmp()),
  ]) {
    expect(r.skills).toEqual([]);
    expect(r.plugins).toBeUndefined();
  }
});

test("oversized skills fail closed: no plugin, nothing left behind", () => {
  const clone = tmp();
  const home = tmp();
  skill(join(clone, ".claude", "skills"), "big");
  writeFileSync(join(clone, ".claude", "skills", "big", "blob"), Buffer.alloc(6 * 1024 * 1024));
  const logs = captureLogs();
  expect(runSkills([{ name: "big", path: clone }], home)).toMatchObject({ skills: [] });
  logs.stop();
  expect(logs.lines.some((l) => l.level === 40 && l.msg === "repo skills not loaded")).toBe(true);
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

/** A repo with `n` skills, each holding one file of `bytes` bytes. */
const repoWithSkills = (n: number, bytes = 1) => {
  const repo = tmp();
  for (let i = 0; i < n; i++) {
    skill(join(repo, ".claude", "skills"), `s${i}`);
    writeFileSync(join(repo, ".claude", "skills", `s${i}`, "f"), Buffer.alloc(bytes));
  }
  return repo;
};

test("one plugin per repo named after the repo; per-repo fail closed does not block the others", () => {
  const home = tmp();
  const a = repoWithSkills(2);
  const b = repoWithSkills(1);
  const big = repoWithSkills(1, 6 * 1024 * 1024); // over the 5 MB repo cap
  const p = runSkills(
    [
      { name: "a", path: a },
      { name: "big", path: big },
      { name: "b", path: b },
    ],
    home,
  );
  expect(p.plugins).toHaveLength(2);
  expect(p.skills.sort()).toEqual(["a:s0", "a:s1", "b:s0"]);
  expect(readdirSync(join(home, "tmp"))).toHaveLength(2); // the failed repo left nothing
  p.cleanup();
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

test("per-repo cap 300 entries (files + dirs): 100 skills x (dir + 2 files) fits, 101 does not", () => {
  const home = tmp();
  const ok = repoWithSkills(100);
  const over = repoWithSkills(101);
  const p = runSkills([{ name: "ok", path: ok }], home);
  expect(p.skills).toHaveLength(100);
  p.cleanup();
  expect(runSkills([{ name: "over", path: over }], home).skills).toEqual([]);
});

test("empty directories count against the cap, and nesting deeper than 8 is refused", () => {
  const home = tmp();
  const bomb = repoWithSkills(1);
  for (let i = 0; i < 301; i++) mkdirSync(join(bomb, ".claude", "skills", "s0", `e${i}`));
  const deep = repoWithSkills(1);
  mkdirSync(join(deep, ".claude", "skills", "s0", "1", "2", "3", "4", "5", "6", "7", "8"), {
    recursive: true,
  });
  const fine = repoWithSkills(1);
  mkdirSync(join(fine, ".claude", "skills", "s0", "1", "2", "3", "4", "5", "6", "7"), {
    recursive: true,
  });
  const logs = captureLogs();
  expect(runSkills([{ name: "bomb", path: bomb }], home).skills).toEqual([]);
  expect(runSkills([{ name: "deep", path: deep }], home).skills).toEqual([]);
  const ok = runSkills([{ name: "fine", path: fine }], home);
  logs.stop();
  expect(ok.skills).toEqual(["fine:s0"]);
  expect(logs.lines.filter((l) => l.msg === "repo skills not loaded")).toHaveLength(2);
  ok.cleanup();
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

test("per-run cap 1000 entries: repos past the run budget get no plugin", () => {
  const home = tmp();
  const repos = ["a", "b", "c", "d"].map((name) => ({ name, path: repoWithSkills(90) })); // 270 each
  const p = runSkills(repos, home);
  // 270 x 3 = 810 fits; the 4th would reach 1080 > 1000.
  expect(p.plugins).toHaveLength(3);
  expect(p.skills.some((x) => x.startsWith("d:"))).toBe(false);
  p.cleanup();
});

test("plugin-name collision warns naming both repos; a failed first build does not reserve the name", () => {
  const home = tmp();
  const logs = captureLogs();
  const p = runSkills(
    [
      { name: "my repo", path: repoWithSkills(1) },
      { name: "my-repo", path: repoWithSkills(1) },
    ],
    home,
  );
  const w = logs.lines.find((l) => l.msg === "repo skills skipped: plugin name collision");
  expect(w).toMatchObject({ repo: "my-repo", other: "my repo" });
  expect(p.plugins).toHaveLength(1);
  p.cleanup();
  // First repo has no skills (nothing built): the second may use the name.
  const q = runSkills(
    [
      { name: "my repo", path: tmp() },
      { name: "my-repo", path: repoWithSkills(1) },
    ],
    home,
  );
  logs.stop();
  expect(q.skills).toEqual(["my-repo:s0"]);
  q.cleanup();
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
