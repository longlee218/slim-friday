import { expect, test } from "bun:test";
import { ASSISTANT_ROLE } from "../src/roles/builtin/assistant-role";
import {
  askRules,
  EXEC,
  EXEC_MEMORY,
  EXEC_RUN_FACTS,
  PLAN,
  PLAN_RUN_FACTS,
  SKILL_RUN_FACTS,
  VAGUE_PLAN_RULE,
} from "../src/roles/builtin/dev-prompts";
import { DEV_ROLE } from "../src/roles/builtin/dev-role";
import { buildSystemPrompt } from "../src/runtime/system-prompt";
import { ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "../src/tools/sdk-tool-names";

const rules = (stage: string) => buildSystemPrompt("", stage).append;
/** Stage contract budget per section (prompt-standard.md), before interpolation of context. */
const SECTION_BUDGET = 1200;

test("every dev section and the QA section fit the 1200 char budget", () => {
  for (const t of [
    PLAN,
    PLAN_RUN_FACTS,
    SKILL_RUN_FACTS,
    EXEC,
    EXEC_RUN_FACTS,
    EXEC_MEMORY,
    VAGUE_PLAN_RULE,
  ])
    expect(t.length).toBeLessThanOrEqual(SECTION_BUDGET);
  const qa = ASSISTANT_ROLE.stages[0]?.promptSections({}) ?? [];
  expect(qa[0]?.length).toBeLessThanOrEqual(SECTION_BUDGET);
});

test("the skills bootstrap block is gone; skills are not described in the prompt", () => {
  for (const stage of ["plan", "exec", "qa"]) {
    const text = rules(stage);
    expect(text).not.toContain("## Skills");
    expect(text).not.toContain("superpowers:<name>");
    expect(text).not.toContain("Skills load through");
  }
});

test("the ask cap is the role's maxAsk, stated once in the ask rules of plan and exec", () => {
  expect(askRules(7)).toContain(`At most 7 ${ASK_USER_QUESTION_TOOL_NAME} calls`);
  expect(rules("plan")).toContain(
    `At most ${DEV_ROLE.maxAsk} ${ASK_USER_QUESTION_TOOL_NAME} calls`,
  );
  for (const stage of ["plan", "exec"]) {
    expect(rules(stage).split(`${ASK_USER_QUESTION_TOOL_NAME} calls per task`).length - 1).toBe(1);
    expect(rules(stage)).not.toContain("at most once per task");
  }
});

test("plan: design request invokes the matching skill, design section first, repo line kept, no subagent text", () => {
  const text = rules("plan");
  expect(text).toContain("invoke the listed skill whose description matches first");
  expect(text).toContain("first section is the design");
  expect(text).toContain('"repo: <name>"');
  expect(text).toContain("no code change; deliverable =");
  expect(text).toContain("Do NOT implement here and commit nothing");
  expect(text).toContain(EXIT_PLAN_MODE_TOOL_NAME);
  expect(text).not.toMatch(/subagent-run-facts|implementer|task-reviewer|brainstorming/);
  expect(text).not.toContain("Memory:");
});

test("vague rule: only 'nothing to plan', a design request is not vague, Need: format kept", () => {
  expect(VAGUE_PLAN_RULE).toContain("no identifiable target");
  expect(VAGUE_PLAN_RULE).toContain("with a named subject is not vague");
  expect(VAGUE_PLAN_RULE).toContain('"Need: <what is missing>"');
  expect(rules("exec")).not.toContain("Need:");
});

test("exec: run facts, no-code-change path, workflow-skill report, memory and git rules kept", () => {
  const text = rules("exec");
  expect(text).toContain("the repo's own checkout");
  expect(text).toContain("plan.md");
  expect(text).toContain("`git` and `gh` in the shell");
  expect(text).toContain("Merge, push or PR only after the owner chose it.");
  expect(text).toContain("by absolute path from the skill's base directory");
  expect(text).toContain('Only when the approved plan itself says "no code change"');
  expect(text).toContain("workflow skill's report format");
  expect(text).toContain('titled exactly "Memory:"');
  expect(text).toContain("NEVER add Co-Authored-By");
  expect(text).not.toContain("git MCP");
  expect(text.indexOf("Outcome:")).toBeLessThan(text.indexOf("`git` and `gh` in the shell"));
});

test("assistant QA: short, answer first, unsure rule, change requests need a task, ESCALATE verbatim", () => {
  const qa = ASSISTANT_ROLE.stages[0]?.promptSections({ escalation: true }) ?? [];
  expect(qa[0]?.length).toBeLessThanOrEqual(1200);
  expect(qa[0]).toContain("Answer first");
  expect(qa[0]).toContain("never guess");
  expect(qa[0]).toContain("it needs a task");
  expect(qa[1]).toContain("`ESCALATE: sonnet`");
  expect(qa[1]).toContain("`ESCALATE: opus`");
});

test("no tool-name literal in the dev prompt module source", async () => {
  const src = await Bun.file(`${import.meta.dir}/../src/roles/builtin/dev-prompts.ts`).text();
  expect(src).not.toMatch(/AskUserQuestion|ExitPlanMode/);
});

test("skill run facts: invoke a matching skill, skip an unavailable step; in plan and exec only", () => {
  expect(SKILL_RUN_FACTS).toContain("description matches the step you are about to do");
  expect(SKILL_RUN_FACTS).toContain("skip it and say so in one line");
  expect(SKILL_RUN_FACTS).not.toMatch(/lean|full|superpowers/);
  for (const stage of ["plan", "exec"]) expect(rules(stage)).toContain(SKILL_RUN_FACTS);
  expect(rules("qa")).not.toContain(SKILL_RUN_FACTS);
  expect(PLAN).toContain("no defect or target named");
  expect(PLAN).toContain("no code change; deliverable = <what>");
  expect(rules("exec")).toContain("Otherwise implement the plan.");
});
