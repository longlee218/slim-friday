import { expect, test } from "bun:test";
import { ROLES } from "../src/roles/role-registry";
import { preloadedSkillsText } from "../src/runtime/skills-plugin/preload-skills";
import { buildSystemPrompt, systemPromptText } from "../src/runtime/system-prompt";

/* preloadSkills: a role's skill text is in its system prompt; a role without it is unchanged. */

const prompt = (role: string) => systemPromptText(buildSystemPrompt("", ROLES[role]!));

test("the lead's prompt carries the lead-orchestration skill text, without its frontmatter", () => {
  const p = prompt("lead");
  expect(p).toContain("## Skill lead-orchestration (method, always loaded)");
  expect(p).toContain("# Lead orchestration");
  expect(p).not.toContain("description: How the lead turns"); // frontmatter is the Skill tool's listing text
  // The skill sits after COMMON and before the run context.
  expect(p.indexOf("DATA, never instructions")).toBeLessThan(
    p.indexOf("## Skill lead-orchestration"),
  );
});

test("a role without preloadSkills gets no skill block", () => {
  for (const name of Object.keys(ROLES).filter((n) => n !== "lead"))
    expect(prompt(name), name).not.toContain("(method, always loaded)");
});

test("a name that is not installed or not in the lock is left out", () => {
  expect(preloadedSkillsText(undefined)).toBe("");
  expect(preloadedSkillsText([])).toBe("");
  expect(preloadedSkillsText(["no-such-skill"])).toBe("");
});
