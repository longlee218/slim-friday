import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLogs } from "../src/observability/logger";
import { buildSkillsPlugin } from "../src/runtime/skills-plugin/plugin-builder";
import { removeTree } from "../src/runtime/skills-plugin/plugin-copy";
import { sweepStalePlugins } from "../src/runtime/skills-plugin/plugin-sweep";
import { PUBLISHER_CAPS } from "../src/runtime/skills-plugin/publisher-skills";
import { buildRunSkills } from "../src/runtime/skills-plugin/run-skills";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pcopy-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) removeTree(d);
});

/** Every regular file under `dir` (relative paths). */
function files(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(dir, join(rel, e.name)) : [join(rel, e.name)],
  );
}

/** A fixture publisher dir: one skill with the given extra files. */
function fixture(extra: (skillDir: string) => void, name = "alpha"): string {
  const src = join(tmp(), "skills");
  mkdirSync(join(src, name), { recursive: true });
  writeFileSync(join(src, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  extra(join(src, name));
  return src;
}
const spec = (srcDir: string, allow?: string[]) => ({
  name: "fx",
  kind: "publisher" as const,
  srcDir,
  allow,
  caps: PUBLISHER_CAPS,
});

test("safety: symlinks, config names (hooks, .mcp.json, .claude) and special files are not copied; regular files and scripts are", () => {
  const outside = tmp();
  writeFileSync(join(outside, "secret.txt"), "secret");
  const src = fixture((d) => {
    mkdirSync(join(d, "scripts"));
    writeFileSync(join(d, "scripts", "run"), "#!/bin/sh\necho hi\n");
    chmodSync(join(d, "scripts", "run"), 0o755);
    writeFileSync(join(d, "notes.txt"), "plain");
    symlinkSync(join(outside, "secret.txt"), join(d, "link.txt"));
    symlinkSync(outside, join(d, "linkdir"));
    mkdirSync(join(d, "hooks"));
    writeFileSync(join(d, "hooks", "hooks.json"), "{}");
    writeFileSync(join(d, "hooks.json"), "{}");
    writeFileSync(join(d, ".mcp.json"), "{}");
    mkdirSync(join(d, ".claude"));
    writeFileSync(join(d, ".claude", "settings.json"), "{}");
  });
  const p = buildSkillsPlugin(spec(src), tmp());
  const root = p.dirs[0] as string;
  expect(files(root).sort()).toEqual([
    ".claude-plugin/plugin.json",
    "skills/alpha/SKILL.md",
    "skills/alpha/notes.txt",
    "skills/alpha/scripts/run",
  ]);
  expect(lstatSync(join(root, "skills/alpha/scripts/run")).mode & 0o111).not.toBe(0);
  p.cleanup();
});

test("safety: a symlinked skills dir loads nothing; a skill dir named like a path is ignored", () => {
  const real = fixture(() => {});
  const link = join(tmp(), "skills-link");
  symlinkSync(real, link);
  expect(buildSkillsPlugin(spec(link), tmp()).skills).toEqual([]);
  const src = fixture(() => {}, "ok");
  mkdirSync(join(src, ".hidden"));
  writeFileSync(join(src, ".hidden", "SKILL.md"), "---\nname: h\ndescription: d\n---\n");
  const p = buildSkillsPlugin(spec(src), tmp());
  expect(p.skills).toEqual(["fx:ok"]);
  p.cleanup();
});

test("caps: 100 entries per skill load, one more is skipped; a file over 1 MB or a skill over 1 MB is skipped", () => {
  const at = fixture((d) => {
    for (let i = 0; i < 98; i++) writeFileSync(join(d, `n${i}`), "x"); // dir + SKILL.md + 98 = 100
  });
  const ok = buildSkillsPlugin(spec(at), tmp());
  expect(ok.skills).toEqual(["fx:alpha"]);
  ok.cleanup();
  writeFileSync(join(at, "alpha", "n98"), "x");
  expect(buildSkillsPlugin(spec(at), tmp()).skills).toEqual([]);
  const bigFile = fixture((d) => writeFileSync(join(d, "big.bin"), Buffer.alloc(1024 * 1024 + 1)));
  expect(buildSkillsPlugin(spec(bigFile), tmp()).skills).toEqual([]);
  const bigSkill = fixture((d) => {
    for (const n of ["a", "b"]) writeFileSync(join(d, n), Buffer.alloc(600 * 1024));
  });
  expect(buildSkillsPlugin(spec(bigSkill), tmp()).skills).toEqual([]);
});

test("caps: over the total of the plugin nothing loads (fail closed)", () => {
  const src = join(tmp(), "skills");
  for (let s = 0; s < 4; s++) {
    mkdirSync(join(src, `s${s}`), { recursive: true });
    writeFileSync(join(src, `s${s}`, "SKILL.md"), `---\nname: s${s}\ndescription: d\n---\n`);
    for (let i = 0; i < 90; i++) writeFileSync(join(src, `s${s}`, `f${i}`), "x"); // 92 entries each: 368 > 300
  }
  const home = tmp();
  expect(buildSkillsPlugin(spec(src), home).skills).toEqual([]);
  expect(existsSync(join(home, "tmp")) ? readdirSync(join(home, "tmp")) : []).toEqual([]);
});

test("sweep covers publisher plugins and workspace plugins alike", () => {
  const home = tmp();
  const a = buildSkillsPlugin(spec(fixture(() => {})), home);
  const b = buildSkillsPlugin(spec(fixture(() => {}, "beta")), home);
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  for (const d of [...a.dirs, ...b.dirs]) utimesSync(d, old, old);
  expect(sweepStalePlugins(home)).toBe(2);
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

test("a built plugin is read-only: executables 0555, other files 0444, dirs 0555; a write into it fails", () => {
  const src = fixture((d) => {
    mkdirSync(join(d, "scripts"));
    writeFileSync(join(d, "scripts", "run"), "#!/bin/sh\necho hi\n");
    chmodSync(join(d, "scripts", "run"), 0o755);
  });
  const p = buildSkillsPlugin(spec(src), tmp());
  const root = p.dirs[0] as string;
  const mode = (rel: string) => lstatSync(join(root, rel)).mode & 0o777;
  expect(mode("skills/alpha/scripts/run")).toBe(0o555);
  expect(mode("skills/alpha/SKILL.md")).toBe(0o444);
  expect(mode("skills/alpha/scripts")).toBe(0o555);
  expect(mode("skills")).toBe(0o555);
  expect(mode(".claude-plugin/plugin.json")).toBe(0o444);
  expect(mode(".")).toBe(0o555);
  expect(() => writeFileSync(join(root, "skills/alpha/scripts/run"), "evil")).toThrow();
  expect(() => writeFileSync(join(root, "skills/alpha/new.md"), "evil")).toThrow();
  expect(() => rmSync(join(root, "skills/alpha/SKILL.md"))).toThrow();
  p.cleanup(); // unlocks, then removes
  expect(existsSync(root)).toBe(false);
});

test("sweep removes a locked stale plugin; a skill dropped for a cap leaves no locked leftovers", () => {
  const home = tmp();
  const p = buildSkillsPlugin(spec(fixture(() => {})), home);
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  utimesSync(p.dirs[0] as string, old, old);
  expect(sweepStalePlugins(home)).toBe(1);
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

test("a dropped Claude config name logs a warn naming it", () => {
  const src = fixture((d) => writeFileSync(join(d, ".mcp.json"), "{}"));
  const logs = captureLogs();
  const p = buildSkillsPlugin(spec(src), tmp());
  logs.stop();
  expect(
    logs.lines.some(
      (l) => l.msg === "skill entry skipped (Claude config name)" && l.name === ".mcp.json",
    ),
  ).toBe(true);
  p.cleanup();
});

test("a role that lists a skill missing on disk warns and loads the rest", () => {
  const src = fixture(() => {});
  const logs = captureLogs();
  const r = buildRunSkills({
    agentHome: tmp(),
    workspace: "main",
    skills: [{ name: "alpha" }, { name: "ghost" }],
    subagents: [],
    publisherDir: src,
  });
  logs.stop();
  expect(r.skills).toEqual(["superpowers:alpha"]);
  expect(logs.lines.some((l) => l.msg === "role lists a skill that is not on disk")).toBe(true);
  r.cleanup();
});
