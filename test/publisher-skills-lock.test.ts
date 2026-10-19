import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillsLock as readSkillsLock2 } from "../src/config/skills-lock";
import { isWorkspaceName, reservedWorkspaces } from "../src/config/workspace-paths";
import { captureLogs } from "../src/observability/logger";
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
    // The path is where the skill sits in its source repo (it may be nested or the repo root).
    expect(entry.skillPath).toMatch(/(^|\/)SKILL\.md$/);
  }
});

test("every skill dir hashes to the computedHash the lock pins (paths and bytes)", () => {
  for (const [name, entry] of Object.entries(lock.skills))
    expect([name, skillDirHash(join(PUBLISHER_SKILLS_DIR, name))]).toEqual([
      name,
      entry.computedHash,
    ]);
});

test("roles pick skills by a data list of installed names", () => {
  for (const role of Object.values(ROLES))
    for (const n of role.skills ?? []) expect(Object.keys(lock.skills)).toContain(n);
  expect(ROLES.lead?.skills).toEqual(["lead-orchestration"]);
});

test("the app skills are locked under the friday source, so their qualified names stay friday:<skill>", () => {
  const friday = Object.entries(lock.skills)
    .filter(([, e]) => e.source.endsWith("/friday"))
    .map(([n]) => n)
    .sort();
  // Other app skills (worker-reporting) may join: the named ones must stay locked as friday:<skill>.
  expect(friday).toEqual(
    expect.arrayContaining([
      "discord-server-manager",
      "docs-seeker",
      "lead-orchestration",
      "plan-work",
      "scout",
    ]),
  );
});

test("workspace name `friday` stays reserved (its plugin name comes from the lock)", () => {
  expect(reservedWorkspaces()).toContain("friday");
  expect(isWorkspaceName("friday")).toBe(false);
});

test("every plugin name of the lock is a reserved workspace name (it would clash with <ws>:<skill>)", () => {
  const plugins = new Set(Object.values(lock.skills).map((e) => e.source.split("/").pop()));
  expect(plugins.size).toBeGreaterThan(0);
  for (const p of plugins) expect(reservedWorkspaces()).toContain(p as string);
  expect(reservedWorkspaces()).toContain("ops");
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

test("readSkillsLock warns (shared logger) on an unreadable lock, a broken lock and two sources with one plugin name", () => {
  const dir = mkdtempSync(join(tmpdir(), "lockwarn-"));
  const msgs = (file: string) => {
    const logs = captureLogs();
    const out = readSkillsLock2(file);
    logs.stop();
    return { out, msgs: logs.lines.map((l) => l.msg) };
  };
  const missing = msgs(join(dir, "none.json"));
  expect(missing.out).toEqual({});
  expect(missing.msgs).toContain("skills lock not read: no publisher skills");
  writeFileSync(join(dir, "bad.json"), "{ nope");
  expect(msgs(join(dir, "bad.json")).msgs).toContain(
    "skills lock is not valid JSON: no publisher skills",
  );
  writeFileSync(
    join(dir, "dup.json"),
    JSON.stringify({ skills: { a: { source: "x/pack" }, b: { source: "y/pack" } } }),
  );
  const dup = msgs(join(dir, "dup.json"));
  expect(Object.keys(dup.out)).toEqual(["a", "b"]);
  expect(dup.msgs).toContain("two skills sources give the same plugin name");
  rmSync(dir, { recursive: true });
});
