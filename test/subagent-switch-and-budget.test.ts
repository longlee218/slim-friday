import { expect, test } from "bun:test";
import { loadConfig } from "../src/config/agent-config";
import {
  ceilingBinds,
  type Route,
  resolveBudget,
  TASK_BUDGET_USD,
} from "../src/config/model-routing";
import { DEFAULT_AGENTS } from "../src/memory/persona-templates";
import { budgetHitReply, ceilingRefusal, withSpent } from "../src/orchestrator/engine/budget";
import { subagentRunFacts } from "../src/roles/builtin/dev-subagent-rules";
import { getRole, getStage, ROLES } from "../src/roles/role-registry";
import { agentsOf } from "../src/roles/subagents/subagent-registry";
import { stageConfig } from "../src/runtime/sdk-options";
import { allowedSkills } from "../src/runtime/skills-plugin/publisher-skills";
import { buildSystemPrompt } from "../src/runtime/system-prompt";
import { spentByOtherStages, upsertStage } from "../src/storage/stage-store";
import { SEND_MESSAGE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { toolsFor } from "../src/tools/tool-catalog";
import { makeEnv } from "./helpers";

// A2 wiring: the role data is the only switch (subagents -> skills, tools, prompt facts), plan and assistant are
// unchanged, and the task budget ceiling math.

const dev = getRole("dev");
const plan = getStage("dev", "plan");
const exec = getStage("dev", "exec");
const qa = getStage("assistant", "qa");
const cfg = (extra: Record<string, string> = {}) => loadConfig({ AGENT_HOME: "/h", ...extra });
const GATED = ["subagent-driven-development", "requesting-code-review", "receiving-code-review"];

test("exec lists explorer, implementer, task-reviewer; plan and assistant stay explorer-only", () => {
  expect(exec.subagents).toEqual(["explorer", "implementer", "task-reviewer"]);
  expect(plan.subagents).toEqual(["explorer"]);
  expect(qa.subagents).toEqual(["explorer"]);
  expect(Object.keys(agentsOf(plan.subagents))).toEqual(["explorer"]);
  expect(Object.keys(agentsOf(exec.subagents))).toEqual([
    "explorer",
    "implementer",
    "task-reviewer",
  ]);
});

test("needs gating: the three skills load only while the stage lists the agents they need", () => {
  const skills = dev.skills ?? [];
  const names = (subs: string[]) => allowedSkills(skills, subs);
  for (const g of GATED) expect(names(exec.subagents ?? [])).toContain(g);
  for (const g of GATED) expect(names(plan.subagents ?? [])).not.toContain(g);
  // Removing the two names from the stage's list turns all three skills off.
  for (const g of GATED) expect(names(["explorer"])).not.toContain(g);
  // Reviewer only: the review skills load, the SDD skill (needs the implementer too) does not.
  expect(names(["explorer", "task-reviewer"])).toEqual(
    expect.arrayContaining(["requesting-code-review", "receiving-code-review"]),
  );
  expect(names(["explorer", "task-reviewer"])).not.toContain("subagent-driven-development");
  // The assistant role has no publisher skills at all.
  expect(ROLES.assistant?.skills ?? []).toEqual([]);
});

test("kill switch = role data: without the two names there is no SendMessage, no agents, no run facts", () => {
  const off = { ...exec, subagents: ["explorer"] };
  expect(toolsFor(off)).not.toContain(SEND_MESSAGE_TOOL_NAME);
  expect(toolsFor(exec)).toContain(SEND_MESSAGE_TOOL_NAME);
  expect(Object.keys(agentsOf(off.subagents))).toEqual(["explorer"]);
  expect(subagentRunFacts(off.subagents)).toBe("");
  expect(subagentRunFacts(["explorer", "implementer"])).toBe(""); // both names or nothing
  const on = subagentRunFacts(exec.subagents ?? []);
  expect(on).toContain("<subagent-run-facts>");
  expect(buildSystemPrompt("", exec).append).toContain(on);
  expect(buildSystemPrompt("", plan).append).not.toContain("<subagent-run-facts>");
  expect(buildSystemPrompt("", qa).append).not.toContain("<subagent-run-facts>");
});

test("run facts: the mapping, the limits and the no-ask rule; short and self-contained", () => {
  const f = subagentRunFacts(exec.subagents ?? []);
  expect(f).toContain("implementer prompt template -> implementer");
  expect(f).toContain("task-reviewer");
  expect(f).toContain("`name`");
  expect(f).toContain("`model`");
  expect(f).toContain(SEND_MESSAGE_TOOL_NAME);
  expect(f).toContain("At most 2 run at once and 40 starts and resumes");
  expect(f).toContain("3 or more tasks");
  expect(f).toContain("never push");
  expect(f.length).toBeLessThan(1500);
});

test("default AGENTS.md carries the commit rule for task clones", () => {
  for (const s of [
    "## Commits in task clones",
    "One commit per task",
    "conventional",
    "No AI attribution",
    "Never push",
    "never amend",
    "secrets",
  ])
    expect(DEFAULT_AGENTS).toContain(s);
});

test("budget: stage budget is capped by what the other stages left of TASK_BUDGET_USD", () => {
  expect(TASK_BUDGET_USD).toBe(6);
  const c = cfg();
  expect(resolveBudget(exec, dev, {}, c)).toBe(3); // nothing spent: the stage budget
  expect(resolveBudget(exec, dev, { spentUsd: 1.5 }, c)).toBe(3);
  expect(resolveBudget(exec, dev, { spentUsd: 4 }, c)).toBe(2);
  expect(resolveBudget(exec, dev, { spentUsd: 6 }, c)).toBe(0);
  expect(resolveBudget(exec, dev, { spentUsd: 9 }, c)).toBe(0); // never negative
  // An owner raise widens the stage, never the ceiling.
  expect(resolveBudget(exec, dev, { extraBudgetUsd: 2 }, c)).toBe(5);
  expect(resolveBudget(exec, dev, { extraBudgetUsd: 5, spentUsd: 4 }, c)).toBe(2);
  // MAX_BUDGET_USD still caps on top; env pin is limited by the ceiling too.
  expect(resolveBudget(exec, dev, { spentUsd: 1 }, cfg({ MAX_BUDGET_USD: "2" }))).toBe(2);
  expect(resolveBudget(exec, dev, { spentUsd: 4 }, cfg({ BUDGET_DEV_EXEC_USD: "5" }))).toBe(2);
  // The assistant's stage budget is untouched by an empty spend.
  expect(resolveBudget(qa, getRole("assistant"), {}, c)).toBe(0.5);
});

test("budget: the stage config carries the ceiling into the SDK maxBudgetUsd; openrouter keeps only its cap", () => {
  expect(stageConfig(exec, cfg(), { spentUsd: 4.5 }).limits.maxBudgetUsd).toBe(1.5);
  expect(stageConfig(exec, cfg(), {}).limits.maxBudgetUsd).toBe(3);
  const or = cfg({ OPENROUTER_API_KEY: `sk-or-v1-${"a1b2c3d4".repeat(8)}` });
  expect(stageConfig(exec, or, { spentUsd: 5 }).limits.maxBudgetUsd).toBeUndefined();
});

test("budget bookkeeping: the spend of the OTHER stages of a task comes from the stage rows", () => {
  const { db } = makeEnv();
  upsertStage(db, { turnId: "t1", idx: 0, name: "plan", status: "done", costUsd: 1.25 });
  upsertStage(db, { turnId: "t1", idx: 1, name: "exec", status: "running", costUsd: 2 });
  upsertStage(db, { turnId: "t2", idx: 0, name: "plan", status: "done", costUsd: 9 });
  expect(spentByOtherStages(db, "t1", 1)).toBe(1.25); // the current stage's own cost is not counted
  expect(spentByOtherStages(db, "t1", 0)).toBe(2);
  expect(spentByOtherStages(db, "none", 1)).toBe(0);
  const i: { turnId: string; route?: Route } = {
    turnId: "t1",
    route: { cls: "design", extraBudgetUsd: 1 },
  };
  expect(withSpent(db, i, 1).route).toEqual({ cls: "design", extraBudgetUsd: 1, spentUsd: 1.25 });
  expect(withSpent(db, { turnId: "none" } as typeof i, 1).route).toBeUndefined(); // nothing spent: input unchanged
  expect(withSpent(db, i, 1).turnId).toBe("t1");
});

test("budget: ceiling used up = the stage is refused up front with an owner message (never budget 0)", () => {
  expect(ceilingRefusal(undefined)).toBeUndefined();
  expect(ceilingRefusal({ spentUsd: 5.99 })).toBeUndefined();
  for (const spent of [6, 7.5]) {
    const msg = ceilingRefusal({ spentUsd: spent });
    expect(msg).toContain("Task ceiling reached");
    expect(msg).toContain("$6.00");
    expect(msg).toContain("cannot lift");
  }
});

test("budget stop message: names the task ceiling and offers no raise when it binds; unchanged when the stage budget binds", () => {
  expect(ceilingBinds(1.5, 4.5)).toBe(true);
  expect(ceilingBinds(3, 1.5)).toBe(false); // stage budget bound (3 + 1.5 < 6)
  expect(ceilingBinds(3, undefined)).toBe(false);
  expect(ceilingBinds(undefined, 4)).toBe(false);
  const ceiling = budgetHitReply({ usage: { costUsd: 1.5 }, budgetUsd: 1.5, ceilingBound: true });
  expect(ceiling).toContain("task ceiling $6.00 reached");
  expect(ceiling).toContain("cannot lift");
  expect(ceiling).not.toContain("Reply `/go");
  const stage = budgetHitReply({ usage: { costUsd: 3 }, budgetUsd: 3 });
  expect(stage).toContain("budget reached ($3.00 of $3.00");
  expect(stage).toContain("`/go +3`");
  expect(stage).not.toContain("ceiling");
});
