import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLES } from "../src/roles/role-registry";
import { buildRoleSkills } from "../src/runtime/skills-plugin/role-skills";

/* Skill loading of the L2a roles through the real plugin builder: the scout gets exactly its two app skills, the lead
   gets none. */

const homes: string[] = [];
/** A fresh agent home per test (the builder writes its plugin copies under it). */
const home = (): string => {
  const d = mkdtempSync(join(tmpdir(), "lead-skills-"));
  homes.push(d);
  return d;
};

afterAll(() => {
  for (const d of homes) rmSync(d, { recursive: true, force: true });
});

test("scout loads exactly its two app skills (scout, docs-seeker) through buildRoleSkills", () => {
  const r = buildRoleSkills(ROLES.scout!, undefined, home());
  try {
    // Plugin skill names are `<plugin>:<skill>`; only the two listed in the role's data load.
    expect(r.skills.map((n) => n.split(":").at(-1)).sort()).toEqual(["docs-seeker", "scout"]);
    expect(r.skills).toHaveLength(2);
    // Each listed skill is a real copy on disk inside one of the run's plugin dirs.
    for (const n of ["scout", "docs-seeker"])
      expect(r.dirs.some((d) => existsSync(join(d, "skills", n, "SKILL.md")))).toBe(true);
  } finally {
    r.cleanup();
  }
});

test("scout's plugin dirs are removed by cleanup", () => {
  const r = buildRoleSkills(ROLES.scout!, undefined, home());
  expect(r.dirs.length).toBeGreaterThan(0);
  r.cleanup();
  for (const d of r.dirs) expect(existsSync(d)).toBe(false);
});

test("lead loads no skill: no skill names, no plugin dirs, no plugins", () => {
  const r = buildRoleSkills(ROLES.lead!, undefined, home());
  try {
    expect(r.skills).toEqual([]);
    expect(r.dirs).toEqual([]);
    expect(r.plugins ?? []).toEqual([]);
  } finally {
    r.cleanup();
  }
});
