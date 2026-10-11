import { expect, test } from "bun:test";
import { MAX_ASK_CALLS_PER_TASK } from "../src/runtime/ask-limit";
import { SKILLS_BOOTSTRAP } from "../src/runtime/prompts/skills-bootstrap";
import { buildSystemPrompt } from "../src/runtime/system-prompt";
import { EXIT_PLAN_MODE_TOOL_NAME, SKILL_TOOL_NAME } from "../src/tools/sdk-tool-names";

const rules = (stage: string) => buildSystemPrompt("", stage).append;

test("dev plan and exec prompts carry the skills bootstrap once; the assistant prompt has none", () => {
  for (const stage of ["plan", "exec"]) {
    const text = rules(stage);
    expect(text).toContain(SKILLS_BOOTSTRAP);
    expect(text.split("## Skills").length - 1).toBe(1);
  }
  expect(rules("qa")).not.toContain("## Skills");
});

test("no overlay mechanism is left in the prompt: skills are loaded unmodified", () => {
  for (const stage of ["plan", "exec"]) expect(rules(stage)).not.toMatch(/overlay/i);
  expect(SKILLS_BOOTSTRAP).toContain("unmodified");
  expect(SKILLS_BOOTSTRAP).not.toMatch(/overlay|wins over|override/i);
});

test("the bootstrap states how skills load and the facts of the run, in under 30 lines", () => {
  expect(SKILLS_BOOTSTRAP.split("\n").length).toBeLessThan(30);
  expect(SKILLS_BOOTSTRAP).toContain(SKILL_TOOL_NAME);
  expect(SKILLS_BOOTSTRAP).toContain("superpowers:<name>");
  expect(SKILLS_BOOTSTRAP).toContain("Only the skills in the list exist");
  expect(SKILLS_BOOTSTRAP).toContain(EXIT_PLAN_MODE_TOOL_NAME);
  expect(SKILLS_BOOTSTRAP).toContain("plan.md");
  expect(SKILLS_BOOTSTRAP).toContain("never shell git");
  expect(SKILLS_BOOTSTRAP).toContain("Subagents never ask");
});

test("the ask cap is one constant, worded the same in the dev rules and the bootstrap", () => {
  expect(MAX_ASK_CALLS_PER_TASK).toBeGreaterThan(1);
  for (const stage of ["plan", "exec"]) {
    const text = rules(stage);
    expect(text).toContain(`At most ${MAX_ASK_CALLS_PER_TASK} AskUserQuestion calls per task`);
    expect(text).toContain(`at most ${MAX_ASK_CALLS_PER_TASK} calls per task in all`);
    expect(text).not.toContain("at most once per task");
  }
});

test("the plan prompt no longer dictates the plan layout (writing-plans does), but keeps the repo line", () => {
  const text = rules("plan");
  expect(text).not.toContain("### Task N");
  expect(text).not.toContain("## Global Constraints");
  expect(text).toContain('"repo: <name>"');
  expect(text).toContain(EXIT_PLAN_MODE_TOOL_NAME);
});
