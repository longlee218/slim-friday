import { describe, expect, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../src/config/agent-config";
import { HAIKU_MODEL, HAIKU_SUMMARY_MODEL, SONNET_MODEL } from "../src/config/model-ids";
import { resolveBudget, TASK_BUDGET_USD } from "../src/config/model-routing";
import { getRole, ROLES } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { roleConfig } from "../src/runtime/sdk-options";
import { makeEnv, resultMsg } from "./helpers";

const cfg = (extra: Record<string, string> = {}) => loadConfig({ AGENT_HOME: "/h", ...extra });
const scout = getRole("scout");
const dev = getRole("developer");

describe("fixed role models", () => {
  test("every role names a full model id (no tier alias)", () => {
    for (const r of Object.values(ROLES)) expect(r.model).toMatch(/^claude-[a-z]+-\d/);
  });
  test("ids per role: lead, planner, developer and roster sonnet; scout and discord-manager haiku; roster specialists sonnet", () => {
    expect(Object.fromEntries(Object.values(ROLES).map((r) => [r.name, r.model]))).toEqual({
      designer: SONNET_MODEL,
      developer: SONNET_MODEL,
      devops: SONNET_MODEL,
      "discord-manager": HAIKU_MODEL,
      hacker: SONNET_MODEL,
      "humanizer-writer": SONNET_MODEL,
      lead: SONNET_MODEL,
      planner: SONNET_MODEL,
      scout: HAIKU_MODEL,
      "solution-architect": SONNET_MODEL,
      tester: SONNET_MODEL,
    });
  });
  test("thinking is role data: lead adaptive, discord-manager disabled, the others the SDK default", () => {
    expect(getRole("lead").thinking).toEqual({ type: "adaptive" });
    expect(getRole("discord-manager").thinking).toEqual({ type: "disabled" });
    expect(dev.thinking).toBeUndefined();
    expect(scout.thinking).toBeUndefined();
  });
});

describe("env", () => {
  test("compaction model is the haiku summary model; MEMORY_MODEL wins", () => {
    expect(cfg().memoryModel).toBe(HAIKU_SUMMARY_MODEL);
    expect(cfg({ MEMORY_MODEL: "m" }).memoryModel).toBe("m");
  });
});

describe("resolveBudget", () => {
  test("role defaults replace the global cap; MAX_BUDGET_USD is a cap", () => {
    const c = cfg();
    expect([scout, dev].map((r) => resolveBudget(r, {}, c))).toEqual([
      scout.budgetUsd,
      dev.budgetUsd,
    ]);
    expect(resolveBudget(dev, {}, cfg({ MAX_BUDGET_USD: "2" }))).toBe(2);
    expect(resolveBudget(scout, {}, cfg({ MAX_BUDGET_USD: "2" }))).toBe(scout.budgetUsd);
  });
  test("owner raise; the task ceiling limits both", () => {
    expect(resolveBudget(dev, { extraBudgetUsd: 1.0 }, cfg())).toBe(dev.budgetUsd + 1);
    expect(resolveBudget(dev, { extraBudgetUsd: TASK_BUDGET_USD }, cfg())).toBe(TASK_BUDGET_USD);
    // what is left of the task ceiling
    expect(resolveBudget(dev, { spentUsd: TASK_BUDGET_USD - 2 }, cfg())).toBe(2);
  });
  test("goal cap: capUsd limits a run below its role budget and is never raised", () => {
    expect(resolveBudget(dev, { capUsd: 5 }, cfg())).toBe(5);
    expect(resolveBudget(dev, { capUsd: 5, extraBudgetUsd: 3 }, cfg())).toBe(5);
    expect(resolveBudget(dev, { capUsd: 0 }, cfg())).toBe(0);
    expect(resolveBudget(dev, { capUsd: TASK_BUDGET_USD * 2 }, cfg())).toBe(dev.budgetUsd);
  });
});

describe("run options", () => {
  test("roleConfig carries the role's model and budget; runAgent passes model, thinking and the turn ceiling", async () => {
    const sc = roleConfig(dev, cfg());
    expect([sc.model, sc.limits.maxBudgetUsd]).toEqual([SONNET_MODEL, dev.budgetUsd]);
    const env = makeEnv();
    const seen: Options[] = [];
    const queryFn = (a: { options?: Options }) =>
      (async function* () {
        seen.push(a.options as Options);
        yield resultMsg();
      })();
    for (const role of [scout, getRole("discord-manager")])
      await runAgent({
        prompt: "q",
        turnId: "t",
        role,
        cwd: env.home,
        config: env.config,
        db: env.db,
        abortController: new AbortController(),
        queryFn: queryFn as never,
      });
    expect("thinking" in seen[0]!).toBe(false);
    expect(seen[0]!.model).toBe(HAIKU_MODEL);
    expect(seen[0]!.maxTurns).toBe(scout.limits.maxTurns);
    expect(seen[1]!.thinking).toEqual({ type: "disabled" });
  });
});
