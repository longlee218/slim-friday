import { expect, test } from "bun:test";
import { ROLES } from "../src/roles/role-registry";
import type { RoleSkill } from "../src/roles/role-types";
import { allowedSkills } from "../src/runtime/skills-plugin/publisher-skills";

const SDD = "subagent-driven-development";
const DEV = ROLES.dev?.skills ?? [];
/** The subagents of a dev stage today: only the explorer. */
const EXPLORER = ["explorer"];
const DEV_NOW = [
  "brainstorming",
  "executing-plans",
  "systematic-debugging",
  "test-driven-development",
  "verification-before-completion",
  "writing-plans",
];
const GATED = [SDD, "requesting-code-review", "receiving-code-review"];

test("allowedSkills: a skill is listed only when the stage has every subagent it needs", () => {
  expect(allowedSkills(DEV, EXPLORER).sort()).toEqual(DEV_NOW);
  expect(allowedSkills(DEV, []).sort()).toEqual(DEV_NOW);
  expect(allowedSkills(DEV, ["explorer", "task-reviewer"]).sort()).toEqual(
    [...DEV_NOW, "requesting-code-review", "receiving-code-review"].sort(),
  );
  expect(allowedSkills(DEV, ["explorer", "implementer", "task-reviewer"]).sort()).toEqual(
    [...DEV_NOW, ...GATED].sort(),
  );
  const generic: RoleSkill[] = [{ name: "x" }, { name: "y", needs: ["a", "b"] }];
  expect(allowedSkills(generic, ["a"])).toEqual(["x"]);
  expect(allowedSkills(generic, ["b", "a"])).toEqual(["x", "y"]);
});

test("the dev role loads the six skills now, gates three on subagents, and every stage shares the list", () => {
  expect(
    DEV.filter((s) => !s.needs)
      .map((s) => s.name)
      .sort(),
  ).toEqual(DEV_NOW);
  expect(Object.fromEntries(DEV.filter((s) => s.needs).map((s) => [s.name, s.needs]))).toEqual({
    [SDD]: ["implementer", "task-reviewer"],
    "requesting-code-review": ["task-reviewer"],
    "receiving-code-review": ["task-reviewer"],
  });
  for (const unloaded of [
    "using-git-worktrees",
    "finishing-a-development-branch",
    "using-superpowers",
    "dispatching-parallel-agents",
    "writing-skills",
    "diagnosing-superpowers",
  ])
    expect(DEV.map((s) => s.name)).not.toContain(unloaded);
  expect(ROLES.assistant?.skills ?? []).toEqual([]);
});
