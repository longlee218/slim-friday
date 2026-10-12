import { expect, test } from "bun:test";
import { ASSISTANT_ROLE } from "../src/roles/builtin/assistant-role";
import {
  askRules,
  DEV,
  DEV_MEMORY,
  DEV_RUN_FACTS,
  SKILL_RUN_FACTS,
} from "../src/roles/builtin/dev-prompts";
import { DEV_ROLE } from "../src/roles/builtin/dev-role";
import { buildSystemPrompt } from "../src/runtime/system-prompt";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";

const rules = (role: typeof DEV_ROLE) => buildSystemPrompt("", role).append;
/** Run contract budget per section (prompt-standard.md), before interpolation of context. */
const SECTION_BUDGET = 1200;

test("every dev section and the QA section fit the 1200 char budget", () => {
  for (const t of [DEV, DEV_RUN_FACTS, SKILL_RUN_FACTS, DEV_MEMORY])
    expect(t.length).toBeLessThanOrEqual(SECTION_BUDGET);
  const qa = ASSISTANT_ROLE.promptSections({}) ?? [];
  expect(qa[0]?.length).toBeLessThanOrEqual(SECTION_BUDGET);
});

test("the skills bootstrap block is gone; skills are not described in the prompt", () => {
  for (const role of [DEV_ROLE, ASSISTANT_ROLE]) {
    const text = rules(role);
    expect(text).not.toContain("## Skills");
    expect(text).not.toContain("superpowers:<name>");
    expect(text).not.toContain("Skills load through");
  }
});

test("the ask cap is the role's limit, stated once in the ask rules", () => {
  expect(askRules(7)).toContain(`At most 7 ${ASK_USER_QUESTION_TOOL_NAME} calls`);
  expect(rules(DEV_ROLE)).toContain(
    `At most ${DEV_ROLE.limits.maxAsk} ${ASK_USER_QUESTION_TOOL_NAME} calls per run`,
  );
  expect(rules(DEV_ROLE).split(`${ASK_USER_QUESTION_TOOL_NAME} calls per run`).length - 1).toBe(1);
});

test("dev: one contract, approval before changes by ask, design request invokes the matching skill, no subagent text", () => {
  const text = rules(DEV_ROLE);
  expect(text).toContain("invoke the listed skill whose description matches first");
  expect(text).toContain("the repo's own checkout");
  expect(text).toContain("Do not change files before the owner approved your plan");
  expect(text).toContain('"repo: <name>"');
  expect(text).toContain("`git` and `gh` in the shell");
  expect(text).toContain("Merge, push or PR only after the owner chose it.");
  expect(text).toContain("by absolute path from the skill's base directory");
  expect(text).toContain("workflow skill's report format");
  expect(text).toContain('titled exactly "Memory:"');
  expect(text).toContain("NEVER add Co-Authored-By");
  expect(text).not.toMatch(/subagent-run-facts|implementer|task-reviewer|brainstorming/);
  expect(text).not.toContain("git MCP");
  expect(text).not.toContain("plan.md"); // no plan file, no handoff
  expect(text.indexOf("Outcome:")).toBeLessThan(text.indexOf("`git` and `gh` in the shell"));
});

test("assistant QA: short, answer first, unsure rule, change requests need a task, ESCALATE verbatim", () => {
  const qa = ASSISTANT_ROLE.promptSections({ escalation: true });
  expect(qa[0]?.length).toBeLessThanOrEqual(1200);
  expect(qa[0]).toContain("Answer first");
  expect(qa[0]).toContain("never guess");
  expect(qa[0]).toContain("is a [dev] task");
  expect(qa[1]).toContain("`ESCALATE: sonnet`");
  expect(qa[1]).toContain("`ESCALATE: opus`");
});

test("no tool-name literal in the dev prompt module source", async () => {
  const src = await Bun.file(`${import.meta.dir}/../src/roles/builtin/dev-prompts.ts`).text();
  expect(src).not.toMatch(/AskUserQuestion|ExitPlanMode/);
});

test("skill run facts: invoke a matching skill, skip an unavailable step; in dev only", () => {
  expect(SKILL_RUN_FACTS).toContain("description matches the step you are about to do");
  expect(SKILL_RUN_FACTS).toContain("skip it and say so in one line");
  expect(SKILL_RUN_FACTS).not.toMatch(/lean|full|superpowers/);
  expect(rules(DEV_ROLE)).toContain(SKILL_RUN_FACTS);
  expect(rules(ASSISTANT_ROLE)).not.toContain(SKILL_RUN_FACTS);
  expect(DEV).toContain("no defect or target named");
});
