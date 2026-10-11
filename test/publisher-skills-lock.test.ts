import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROLES } from "../src/roles/role-registry";
import { PUBLISHER_SKILLS_DIR } from "../src/runtime/skills-plugin/publisher-skills";
import { readSkillsLock, skillDirHash } from "./skills-lock-hash";

const lock = readSkillsLock();

test("skills-lock.json lists exactly the skill dirs of .agents/skills, each with its SKILL.md", () => {
  const onDisk = readdirSync(PUBLISHER_SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  expect(Object.keys(lock.skills).sort()).toEqual(onDisk);
  for (const [name, entry] of Object.entries(lock.skills)) {
    expect(existsSync(join(PUBLISHER_SKILLS_DIR, name, "SKILL.md"))).toBe(true);
    expect(entry.skillPath).toBe(`skills/${name}/SKILL.md`);
  }
});

test("every skill dir hashes to the computedHash the lock pins (paths and bytes)", () => {
  for (const [name, entry] of Object.entries(lock.skills))
    expect([name, skillDirHash(join(PUBLISHER_SKILLS_DIR, name))]).toEqual([
      name,
      entry.computedHash,
    ]);
});

test("every skill a role lists is pinned in the lock", () => {
  for (const role of Object.values(ROLES))
    for (const s of role?.skills ?? []) expect(Object.keys(lock.skills)).toContain(s.name);
});

test("the publisher dir holds no symlinks, and the scripts keep their exec bit", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  for (const f of walk(PUBLISHER_SKILLS_DIR)) expect(lstatSync(f).isSymbolicLink()).toBe(false);
  for (const s of [
    "executing-plans/scripts/task-start",
    "subagent-driven-development/scripts/task-brief",
  ])
    expect(lstatSync(join(PUBLISHER_SKILLS_DIR, s)).mode & 0o111).not.toBe(0);
});

test("the app's own .agents/skills dir is the source", () => {
  expect(PUBLISHER_SKILLS_DIR.endsWith("/.agents/skills")).toBe(true);
  expect(existsSync(join(PUBLISHER_SKILLS_DIR, "brainstorming", "SKILL.md"))).toBe(true);
});
