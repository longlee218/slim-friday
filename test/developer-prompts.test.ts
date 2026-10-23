import { expect, test } from "bun:test";
import { getRole } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import { buildSystemPrompt, systemPromptText } from "../src/runtime/system-prompt";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";

const DEVELOPER_ROLE = getRole("developer");
const CHIEF_OF_STAFF_ROLE = getRole("chief-of-staff");
const rules = (role: RoleDefinition) => systemPromptText(buildSystemPrompt("", role));

/* The 1200-char per-section budget is replaced by a per-role ceiling on the whole contract (owner direction 2026-10-20:
   rich contracts; ceilings in test/role-contract-sections.test.ts). */

test("the skills bootstrap block is gone; skills are not described in the prompt", () => {
  for (const role of [DEVELOPER_ROLE, CHIEF_OF_STAFF_ROLE]) {
    const text = rules(role);
    expect(text).not.toContain("## Skills");
    expect(text).not.toContain("superpowers:<name>");
    expect(text).not.toContain("Skills load through");
  }
});

test("the prompt states no owner-question count (the ask capability is the switch)", () => {
  expect(rules(DEVELOPER_ROLE)).toContain(ASK_USER_QUESTION_TOOL_NAME);
  expect(rules(DEVELOPER_ROLE)).not.toMatch(/at most \d+ (per run|AskUserQuestion)/i);
});

test("dev: one contract, approval before changes by ask, a design request may end with no code change, no skill routing, no subagent text", () => {
  // The contract only: the preloaded using-skills text (credit line, process skill names) is checked in preload-skills.test.ts.
  const text = DEVELOPER_ROLE.promptSections().join("\n");
  expect(text).not.toContain("invoke the listed skill"); // the SDK matches skills by description: no routing line
  expect(text).toContain("the deliverable may be a design or plan with no code change");
  expect(text).toContain("the location's own checkout");
  expect(text).toContain("The brief is the approved plan");
  expect(text).not.toContain('"location: <name>"'); // no location marker line any more
  expect(text).not.toContain("OS sandbox"); // the sandbox is off by config: no prompt line states it
  expect(text).toContain("merge, push or PR only after the owner chose it");
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
    "## Scope",
    "## How the work goes",
    "## Asking the teammate",
    "## Commits",
    "## Environment facts",
    "## Stop, ask or fail",
  ].map(at);
  expect(order.every((i) => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(at("## Mission")).toBeLessThan(at("## Environment facts"));
});

test("no tool-name literal in the dev prompt file (tool names come from {{tool.X}})", async () => {
  const src = await Bun.file(`${import.meta.dir}/../config/presets/developer/prompt.md`).text();
  expect(src).not.toMatch(/(?<!tool\.)AskUserQuestion|ExitPlanMode/);
});

test("dev contract: research path; skill use and location memory are left to the SDK and AGENTS.md", () => {
  expect(rules(DEVELOPER_ROLE)).not.toContain("description matches the step you are about to do");
  expect(rules(DEVELOPER_ROLE)).not.toMatch(/\[workflow: (full|lean)\]/);
  expect(rules(DEVELOPER_ROLE)).toContain("no defect or target named");
  expect(rules(DEVELOPER_ROLE)).toContain("## Mission");
});
