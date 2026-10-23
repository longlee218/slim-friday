import { expect, test } from "bun:test";
import { OPUS_MODEL, SONNET_MODEL } from "../src/config/model-ids";
import { REPORT_TOOL } from "../src/mcp/orchestration/tools/ReportTool/constants";
import { validateRole } from "../src/orchestrator/run/validate-role";
import { SPECIALIST_BUDGET_USD } from "../src/roles/builtin/specialist-contract";
import { validateRegistry } from "../src/roles/capability-registry";
import { dispatchableWorkers, getRole } from "../src/roles/role-registry";
import { toolsFor } from "../src/tools/tool-catalog";

/* The six roster specialists are flat role data: same contract, no delivery, no teammate tools; subagents only for the tester (D7). */

const ROSTER = ["solution-architect", "designer", "tester", "devops", "humanizer-writer", "hacker"];

test("every roster role is a dispatchable worker (Sonnet, the designer Opus) that validates and reports through Report result", () => {
  validateRegistry();
  for (const name of ROSTER) {
    const r = getRole(name);
    expect(validateRole(r)).toBeUndefined();
    expect([name, r.kind, r.dispatchable, r.noSubagents ?? false]).toEqual([
      name,
      "worker",
      true,
      name !== "tester",
    ]);
    expect(r.model).toBe(name === "designer" ? OPUS_MODEL : SONNET_MODEL);
    expect(r.budgetUsd).toBe(SPECIALIST_BUDGET_USD);
    expect(r.mcpTools).toContain(REPORT_TOOL);
    expect(r.limits.maxAsk).toBe(0);
    expect(dispatchableWorkers().map((w) => w.name)).toContain(name);
  }
});

test("the roster has no effect tool and no ask capability: only the developer delivers", () => {
  for (const name of ROSTER) {
    const r = getRole(name);
    expect(
      r.mcpTools?.some((t) => /Push|PullRequest|Merge|DeletePaths|Plan|Dispatch/.test(t)),
    ).toBe(false);
    expect(r.capabilities).not.toContain("ask");
  }
});

test("side effects match the capabilities: write means location; the readers change nothing", () => {
  for (const name of ROSTER) {
    const r = getRole(name);
    expect([name, r.capabilities.includes("write")]).toEqual([name, r.sideEffects === "location"]);
  }
  expect(toolsFor(getRole("hacker"))).toContain("Bash");
  expect(toolsFor(getRole("solution-architect"))).not.toContain("Bash");
  expect(toolsFor(getRole("humanizer-writer"))).not.toContain("Bash");
});

test("whenToUse of the roster stays distinct from the older roles", () => {
  const all = dispatchableWorkers().map((r) => r.whenToUse);
  expect(new Set(all).size).toBe(all.length);
});
