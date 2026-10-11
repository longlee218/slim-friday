import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PINNED_SCRIPTS, SKILL_SETS_DIR } from "../src/runtime/skills-plugin/skill-sets";

const SET = join(SKILL_SETS_DIR, "superpowers");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Every file under `dir` (relative, posix), recursing; entries are lstat-ed so a symlink shows up as a non-file. */
function walk(dir: string, rel = ""): { rel: string; mode: number; file: boolean }[] {
  return readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    const st = lstatSync(join(dir, r));
    return st.isDirectory() ? walk(dir, r) : [{ rel: r, mode: st.mode, file: st.isFile() }];
  });
}

/** `| \`path\` | sha256 |` rows of VENDOR.md. */
function vendorRows(): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of readFileSync(join(SET, "VENDOR.md"), "utf8").split("\n")) {
    const m = /^\| `([^`]+)` \| ([0-9a-f]{64}) \|$/.exec(line);
    if (m) rows.set(m[1] as string, m[2] as string);
  }
  return rows;
}

test("LICENSE is the upstream MIT text and VENDOR.md pins version 6.4.1", () => {
  expect(readFileSync(join(SET, "LICENSE"), "utf8")).toContain("MIT License");
  expect(readFileSync(join(SET, "VENDOR.md"), "utf8")).toContain("6.4.1");
});

test("every vendored file has a VENDOR.md row with its sha256, and no row is orphaned", () => {
  const rows = vendorRows();
  const onDisk = walk(join(SET, "skills"));
  expect(onDisk.every((f) => f.file)).toBe(true); // no symlinks
  expect(onDisk.map((f) => `skills/${f.rel}`).sort()).toEqual([...rows.keys()].sort());
  for (const f of onDisk)
    expect(sha(join(SET, "skills", f.rel))).toBe(rows.get(`skills/${f.rel}`) as string);
});

test("the only non-.md vendored files are the 3 pinned SDD scripts, executable", () => {
  const odd = walk(join(SET, "skills")).filter((f) => !f.rel.endsWith(".md"));
  expect(odd.map((f) => f.rel).sort()).toEqual(Object.keys(PINNED_SCRIPTS).sort());
  for (const f of odd) {
    expect(f.mode & 0o111).not.toBe(0);
    expect(sha(join(SET, "skills", f.rel))).toBe(PINNED_SCRIPTS[f.rel] as string);
  }
});

test("dropped skills are absent; the kept ones each have a SKILL.md", () => {
  const kept = readdirSync(join(SET, "skills")).sort();
  expect(kept).toEqual(
    [
      "brainstorming",
      "executing-plans",
      "receiving-code-review",
      "requesting-code-review",
      "subagent-driven-development",
      "systematic-debugging",
      "test-driven-development",
      "verification-before-completion",
      "writing-plans",
    ].sort(),
  );
  for (const k of kept) expect(existsSync(join(SET, "skills", k, "SKILL.md"))).toBe(true);
});

test("set.json names only kept skills (flat list or the legacy per-stage shape)", () => {
  const set = JSON.parse(readFileSync(join(SET, "set.json"), "utf8")) as {
    name: string;
    skills: string[] | Record<string, unknown>;
  };
  expect(set.name).toBe("superpowers");
  const skills = Array.isArray(set.skills) ? set.skills : Object.keys(set.skills);
  for (const skill of skills) expect(existsSync(join(SET, "skills", skill, "SKILL.md"))).toBe(true);
});

test("each overlay header names an upstream file and its pinned sha256", () => {
  const overlays = join(SET, "overlays");
  const stubs = walk(overlays).filter((f) => f.rel.endsWith(".md"));
  expect(stubs.length).toBeGreaterThan(0);
  const rows = vendorRows();
  for (const f of stubs) {
    const first = readFileSync(join(overlays, f.rel), "utf8").split("\n")[0] ?? "";
    const m = /^<!-- overlay of (\S+)@([0-9a-f]{64}) -->$/.exec(first);
    expect(m).not.toBeNull();
    expect(rows.get(m?.[1] as string)).toBe(m?.[2] as string);
    expect(sha(join(SET, m?.[1] as string))).toBe(m?.[2] as string);
  }
});
