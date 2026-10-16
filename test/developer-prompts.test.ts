import { expect, test } from "bun:test";
import {
  askRules,
  CODE_STANDARDS,
  COMMIT_RULES,
  DEVELOPER,
  DEVELOPER_ROLE,
  DEVELOPER_RUN_FACTS,
  DEVELOPER_SHELL_RULES,
} from "../src/roles/builtin/developer-role";
import { LEAD_ROLE } from "../src/roles/builtin/lead-role";
import { buildSystemPrompt } from "../src/runtime/system-prompt";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";

const rules = (role: typeof DEVELOPER_ROLE) => buildSystemPrompt("", role).append;
/** Run contract budget per section (prompt-standard.md), before interpolation of context. */
const SECTION_BUDGET = 1200;

test("every dev section and the lead section fit the 1200 char budget", () => {
  for (const t of [
    DEVELOPER,
    DEVELOPER_RUN_FACTS,
    DEVELOPER_SHELL_RULES,
    COMMIT_RULES,
    CODE_STANDARDS,
  ])
    expect(t.length).toBeLessThanOrEqual(SECTION_BUDGET);
  const lead = LEAD_ROLE.promptSections({}) ?? [];
  expect(lead[0]?.length).toBeLessThanOrEqual(SECTION_BUDGET);
});

test("the skills bootstrap block is gone; skills are not described in the prompt", () => {
  for (const role of [DEVELOPER_ROLE, LEAD_ROLE]) {
    const text = rules(role);
    expect(text).not.toContain("## Skills");
    expect(text).not.toContain("superpowers:<name>");
    expect(text).not.toContain("Skills load through");
  }
});

test("the ask cap is the role's limit, stated once in the ask rules", () => {
  expect(askRules(7)).toContain(`At most 7 ${ASK_USER_QUESTION_TOOL_NAME} calls`);
  expect(rules(DEVELOPER_ROLE)).toContain(
    `At most ${DEVELOPER_ROLE.limits.maxAsk} ${ASK_USER_QUESTION_TOOL_NAME} calls per run`,
  );
  expect(
    rules(DEVELOPER_ROLE).split(`${ASK_USER_QUESTION_TOOL_NAME} calls per run`).length - 1,
  ).toBe(1);
});

test("dev: one contract, approval before changes by ask, design request invokes the matching skill, no subagent text", () => {
  const text = rules(DEVELOPER_ROLE);
  expect(text).toContain("invoke the listed skill whose description matches first");
  expect(text).toContain("the location's own checkout");
  expect(text).toContain("Do not change files before the owner approved your plan");
  expect(text).not.toContain('"location: <name>"'); // no location marker line any more
  expect(text).toContain("`git` in the shell");
  expect(text).toContain("Merge, push or PR only after the owner chose it.");
  expect(text).toContain("by absolute path from the skill's base directory");
  expect(text).not.toContain("Memory:");
  expect(text).not.toContain("MemorySave (scope location;"); // location memory rule lives in AGENTS.md
  expect(text).toContain("NEVER add Co-Authored-By");
  expect(text).toContain("add only the files of the task to a commit");
  expect(text).toContain("Surgical changes");
  expect(text).not.toContain("using-superpowers");
  expect(text).not.toMatch(/subagent-run-facts|implementer|task-reviewer|brainstorming/);
  expect(text).not.toContain("git MCP");
  expect(text).not.toContain("plan.md"); // no plan file, no handoff
  expect(text.indexOf("Outcome:")).toBeLessThan(text.indexOf("`git` in the shell"));
});

test("no tool-name literal in the dev role source", async () => {
  const src = await Bun.file(`${import.meta.dir}/../src/roles/builtin/developer-role.ts`).text();
  expect(src).not.toMatch(/AskUserQuestion|ExitPlanMode/);
});

test("dev contract: research path; skill use and location memory are left to the SDK and AGENTS.md", () => {
  expect(rules(DEVELOPER_ROLE)).not.toContain("description matches the step you are about to do");
  expect(rules(DEVELOPER_ROLE)).not.toMatch(/\[workflow: (full|lean)\]/);
  expect(DEVELOPER).toContain("no defect or target named");
});
