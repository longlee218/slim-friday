import { expect, test } from "bun:test";
import { ROLES } from "../src/roles/role-registry";
import { requiredSkillsText } from "../src/runtime/skills-plugin/required-skills";
import { buildSystemPrompt, systemPromptText } from "../src/runtime/system-prompt";

/* requiredSkills: per-role data, a subset of `skills`, named in one generated prompt line. */

const prompt = (role: string) => systemPromptText(buildSystemPrompt("", ROLES[role]!));

test("requiredSkills is a subset of skills for every role", () => {
  for (const [name, role] of Object.entries(ROLES))
    for (const skill of role.requiredSkills ?? [])
      expect(role.skills ?? [], `${name}: ${skill}`).toContain(skill);
});

test("required sets per role", () => {
  const set = (r: string) => ROLES[r]?.requiredSkills ?? [];
  expect(set("developer")).toEqual([
    "writing-plans",
    "executing-plans",
    "test-driven-development",
    "verification-before-completion",
  ]);
  expect(set("tester")).toEqual(["verification-before-completion", "test-master"]);
  expect(set("devops")).toEqual(["verification-before-completion", "devops-engineer"]);
  expect(set("hacker")).toEqual(["security-and-hardening", "verification-before-completion"]);
  expect(set("designer")).toEqual(["ui-ux-pro-max", "impeccable"]);
  expect(set("solution-architect")).toEqual(["architecture-designer"]);
  expect(set("humanizer-writer")).toEqual(["technical-writing", "verification-before-completion"]);
  expect(set("researcher")).toEqual(["deep-research"]);
  for (const r of ["scout", "planner", "lead", "discord-manager"]) expect(set(r)).toEqual([]);
});

test("brainstorming belongs to the lead only", () => {
  for (const [name, role] of Object.entries(ROLES))
    expect(role.skills?.includes("brainstorming") ?? false, name).toBe(name === "lead");
  expect(ROLES.lead?.preloadSkills ?? []).not.toContain("brainstorming");
});

test("the prompt has one line with the qualified names, after the preloaded skills", () => {
  const p = prompt("developer");
  const line = requiredSkillsText(ROLES.developer?.requiredSkills);
  expect(line).toContain("superpowers:test-driven-development");
  expect(line).toContain("superpowers:verification-before-completion");
  expect(p).toContain(line);
  expect(p.split("Required skills for this role").length).toBe(2);
  expect(p.indexOf("## Skill using-skills")).toBeLessThan(
    p.indexOf("Required skills for this role"),
  );
});

test("a role without required skills has no such line", () => {
  expect(prompt("scout")).not.toContain("Required skills for this role");
  expect(requiredSkillsText(undefined)).toBe("");
  expect(requiredSkillsText(["not-installed-skill"])).toBe("");
});
