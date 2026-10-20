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

/** Worker roles that preload the process skill `using-skills`. */
const PRELOADING = [
  "developer",
  "tester",
  "devops",
  "hacker",
  "designer",
  "solution-architect",
  "humanizer-writer",
];

test("every preloaded skill of every role is also in its skills list", () => {
  for (const [name, role] of Object.entries(ROLES))
    for (const skill of role.preloadSkills ?? [])
      expect(role.skills ?? [], `${name}: ${skill}`).toContain(skill);
});

test("the seven process roles preload using-skills; their prompt carries its text", () => {
  expect(
    Object.keys(ROLES)
      .filter((n) => ROLES[n]!.preloadSkills?.includes("using-skills"))
      .sort(),
  ).toEqual([...PRELOADING].sort());
  for (const name of PRELOADING) {
    const p = prompt(name);
    expect(p, name).toContain("## Skill using-skills (method, always loaded)");
    expect(p, name).toContain("### The Rule");
    expect(p, name).toContain("### Friday facts");
    expect(p, name).not.toContain("description: How a Friday worker finds"); // frontmatter stays out
  }
});

test("a role that preloads nothing gets no skill block", () => {
  for (const name of Object.keys(ROLES).filter((n) => !ROLES[n]!.preloadSkills?.length))
    expect(prompt(name), name).not.toContain("(method, always loaded)");
});

test("a name that is not installed or not in the lock is left out", () => {
  expect(preloadedSkillsText(undefined)).toBe("");
  expect(preloadedSkillsText([])).toBe("");
  expect(preloadedSkillsText(["no-such-skill"])).toBe("");
});

test("injected blocks nest under their own heading: the skill's headings sit two levels down", () => {
  const text = preloadedSkillsText(["lead-orchestration"]);
  expect(text).toContain("### Lead orchestration"); // was `# `
  expect(text).toContain("#### Always"); // was `## `
  expect(text).not.toMatch(/^## (Always|Strategy|Brief)/m);
});
