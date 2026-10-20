import { expect, test } from "bun:test";
import {
  askRules,
  DEVELOPER,
  DEVELOPER_ROLE,
  DEVELOPER_WORK,
} from "../src/roles/builtin/developer-role";
import { LEAD_ROLE } from "../src/roles/builtin/lead-role";
import { buildSystemPrompt, systemPromptText } from "../src/runtime/system-prompt";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";

const rules = (role: typeof DEVELOPER_ROLE) => systemPromptText(buildSystemPrompt("", role));

/* The 1200-char per-section budget is replaced by a per-role ceiling on the whole contract (owner direction 2026-10-20:
   rich contracts; ceilings in test/role-contract-sections.test.ts). */

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

test("dev: one contract, approval before changes by ask, a design request may end with no code change, no skill routing, no subagent text", () => {
  const text = rules(DEVELOPER_ROLE);
  expect(text).not.toContain("invoke the listed skill"); // the SDK matches skills by description: no routing line
  expect(text).toContain("the deliverable may be a design or plan with no code change");
  expect(text).toContain("the location's own checkout");
  expect(text).toContain("change no file before the owner approved your plan");
  expect(text).not.toContain('"location: <name>"'); // no location marker line any more
  expect(text).toContain("git works in the shell");
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
  // Section order: Mission and Method first, the shared worker block, then scope ... environment, stop rules last.
  const at = (h: string) => text.indexOf(h);
  const order = [
    "## Mission",
    "## Method",
    "## How the team works",
    "## Scope and hand-offs",
    "## How the work goes",
    "## Asking the owner",
    "## Commits",
    "## Environment facts",
    "## Stop, ask or fail",
  ].map(at);
  expect(order.every((i) => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(at("## Mission")).toBeLessThan(at("git works in the shell"));
});

test("no tool-name literal in the dev role source", async () => {
  const src = await Bun.file(`${import.meta.dir}/../src/roles/builtin/developer-role.ts`).text();
  expect(src).not.toMatch(/AskUserQuestion|ExitPlanMode/);
});

test("dev contract: research path; skill use and location memory are left to the SDK and AGENTS.md", () => {
  expect(rules(DEVELOPER_ROLE)).not.toContain("description matches the step you are about to do");
  expect(rules(DEVELOPER_ROLE)).not.toMatch(/\[workflow: (full|lean)\]/);
  expect(DEVELOPER_WORK).toContain("no defect or target named");
  expect(DEVELOPER).toContain("## Mission");
});
