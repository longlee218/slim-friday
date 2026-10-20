import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLES } from "../src/roles/role-registry";
import { removeTree } from "../src/runtime/skills-plugin/plugin-copy";
import { buildRoleSkills } from "../src/runtime/skills-plugin/role-skills";

/*
 * Leak check: a run sees only the skills its role lists (`RoleDefinition.skills`). The plugin dirs hold only those
 * skill folders and the `skills` option names only those qualified names, so the Skill tool refuses any other
 * (real-SDK canary: scripts/probe-skill-activation.ts --role lead asked to call a worker skill -> error result).
 */
const home = mkdtempSync(join(tmpdir(), "noleak-"));
afterAll(() => removeTree(home));

test("every role gets exactly its listed skills: option names and plugin folders", () => {
  for (const role of Object.values(ROLES)) {
    const sk = buildRoleSkills(role, undefined, home);
    const listed = [...(role.skills ?? [])].sort();
    // `<plugin>:<skill>` -> skill
    expect(sk.skills.map((s) => s.split(":").slice(1).join(":")).sort()).toEqual(listed);
    const onDisk = sk.dirs.flatMap((d) => readdirSync(join(d, "skills")));
    expect(onDisk.sort()).toEqual(listed);
    sk.cleanup();
  }
});

test("the lead holds one skill and no worker skill is in its plugin", () => {
  const sk = buildRoleSkills(ROLES.lead!, undefined, home);
  expect(sk.skills).toEqual(["friday:lead-orchestration"]);
  expect(sk.dirs.flatMap((d) => readdirSync(join(d, "skills")))).toEqual(["lead-orchestration"]);
  sk.cleanup();
});
