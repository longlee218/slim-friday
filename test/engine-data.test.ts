import { expect, test } from "bun:test";
import {
  GATES,
  stageKind,
  stateOfApprovalTool,
  stateOfGate,
} from "../src/orchestrator/engine/gates";
import { renderHandoff } from "../src/orchestrator/engine/handoff";
import { DEV_ROLE } from "../src/roles/builtin/dev-role";
import type { StageDefinition, StageHandoff } from "../src/roles/role-types";

const H = { planFile: "plan.md", template: "P={plan} F={planPath} T={task}\n{testLine}" };
const V = { plan: "the plan", planPath: "/s/plan.md", task: "do it" };

test("renderHandoff fills the placeholders and words the test line", () => {
  expect(renderHandoff(H, { ...V, testCommand: "bun test" })).toBe(
    "P=the plan F=/s/plan.md T=do it\nTest command: bun test",
  );
  expect(renderHandoff(H, V)).toBe("P=the plan F=/s/plan.md T=do it\nNo test command given.");
});

test("renderHandoff is one pass: inserted text is never expanded, unknown words stay", () => {
  const out = renderHandoff(
    { planFile: "p", template: "{plan}|{unknown}|{constructor}" },
    { ...V, plan: "has {task} and {testLine}" },
  );
  expect(out).toBe("has {task} and {testLine}|{unknown}|{constructor}");
});

test("the dev plan stage hands on with the exact prompt the callback used to build", () => {
  const h = DEV_ROLE.stages[0]?.handoff;
  expect(h?.planFile).toBe("plan.md");
  expect(renderHandoff(h as StageHandoff, { ...V, testCommand: "make t" })).toBe(
    "Approved plan (also saved at /s/plan.md):\n\nthe plan\n\nOriginal task: do it\n\nTest command: make t",
  );
});

test("gate table: every gate but none has an approval label and a state", () => {
  expect(Object.keys(GATES).sort()).toEqual(["owner-confirm", "plan-approval"]); // no delivery gate since Rev 15
  expect(stateOfGate("plan-approval")).toBe("awaiting_plan_approval");
  expect(stateOfGate("none")).toBeUndefined();
  expect(stateOfApprovalTool("CreatePR")).toBeUndefined(); // the PR button is gone
  expect(stateOfApprovalTool("Bash")).toBeUndefined();
});

test("stageKind comes from gate + capability data (a stage that writes runs in the repo); owner-confirm is not runnable yet", () => {
  const base: StageDefinition = {
    name: "x",
    capabilities: [],
    gitGroups: [],
    promptSections: () => [],
    model: "haiku",
    budgetUsd: 1,
  };
  expect(stageKind({ ...base, gate: "plan-approval" })).toBe("plan");
  expect(stageKind({ ...base, capabilities: ["read", "write"] })).toBe("repo");
  expect(stageKind({ ...base, capabilities: ["write"], gate: "none" })).toBe("repo");
  expect(stageKind({ ...base, capabilities: ["read"] })).toBe("plain");
  expect(stageKind({ ...base })).toBe("plain");
  expect(stageKind({ ...base, gate: "owner-confirm" })).toBe("unsupported");
  expect(stageKind({ ...base, capabilities: ["write"], gate: "plan-approval" })).toBe("plan");
});
