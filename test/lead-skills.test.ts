import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLES } from "../src/roles/role-registry";
import { buildRoleSkills } from "../src/runtime/skills-plugin/role-skills";

/* Skill loading of the L2a roles through the real plugin builder: the scout gets exactly its two skills, the lead
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

test("scout loads exactly the skills of its role data through buildRoleSkills", () => {
  const r = buildRoleSkills(ROLES.scout!, undefined, home());
  const listed = [...(ROLES.scout?.skills ?? [])];
  try {
    // Plugin skill names are `<plugin>:<skill>`; only the ones listed in the role's data load.
    expect(r.skills.map((n) => n.split(":").at(-1)).sort()).toEqual([...listed].sort());
    expect(r.skills).toHaveLength(listed.length);
    // Each listed skill is a real copy on disk inside one of the run's plugin dirs.
    for (const n of listed)
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

test("lead loads only its method skill: friday:lead-orchestration in one plugin dir", () => {
  const r = buildRoleSkills(ROLES.lead!, undefined, home());
  try {
    expect(r.skills).toEqual(["friday:lead-orchestration"]);
    expect(r.dirs).toHaveLength(1);
    expect(r.plugins ?? []).toHaveLength(1);
  } finally {
    r.cleanup();
  }
});
