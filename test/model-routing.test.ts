import { describe, expect, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../src/config/agent-config";
import { HAIKU_MODEL, SONNET_MODEL } from "../src/config/model-ids";
import { resolveBudget } from "../src/config/model-routing";
import { getRole, ROLES } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { MAX_TURNS, roleConfig } from "../src/runtime/sdk-options";
import { makeEnv, resultMsg } from "./helpers";

const cfg = (extra: Record<string, string> = {}) => loadConfig({ AGENT_HOME: "/h", ...extra });
const scout = getRole("scout");
const dev = getRole("developer");

describe("fixed role models", () => {
  test("every role names a full model id (no tier alias)", () => {
    for (const r of Object.values(ROLES)) expect(r.model).toMatch(/^claude-[a-z]+-\d/);
  });
  test("ids per role: lead, planner, developer sonnet; scout and discord-manager haiku", () => {
    expect(Object.fromEntries(Object.values(ROLES).map((r) => [r.name, r.model]))).toEqual({
      developer: SONNET_MODEL,
      "discord-manager": HAIKU_MODEL,
      lead: SONNET_MODEL,
      planner: SONNET_MODEL,
      scout: HAIKU_MODEL,
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
  test("compaction model is the haiku model; MEMORY_MODEL wins", () => {
    expect(cfg().memoryModel).toBe(HAIKU_MODEL);
    expect(cfg({ MEMORY_MODEL: "m" }).memoryModel).toBe("m");
  });
  test("BUDGET_<ROLE>_USD and COMPACT_WINDOW_<ROLE> are collected; a bad value names the var", () => {
    const c = cfg({ BUDGET_DEVELOPER_USD: "5", COMPACT_WINDOW_DEVELOPER: "200000" });
    expect(c.budgetOverrides.developer).toBe(5);
    expect(c.compactOverrides.developer).toBe(200000);
    expect(() => cfg({ BUDGET_DEVELOPER_USD: "abc" })).toThrow("BUDGET_DEVELOPER_USD");
  });
  test("removed MODEL / MODEL_<X> and the old two-part shapes are ignored and reported as deprecated", () => {
    const c = cfg({
      MODEL: "m",
      MODEL_DEV: "opus",
      MODEL_SONNET: "s",
      BUDGET_DEV_EXEC_USD: "5",
      COMPACT_WINDOW_DEV_EXEC: "200000",
    });
    expect(c.deprecated.sort()).toEqual([
      "BUDGET_DEV_EXEC_USD",
      "COMPACT_WINDOW_DEV_EXEC",
      "MODEL",
      "MODEL_DEV",
      "MODEL_SONNET",
    ]);
    expect([c.budgetOverrides, c.compactOverrides]).toEqual([{}, {}]);
    expect(roleConfig(dev, c).model).toBe(SONNET_MODEL); // the pin did not apply
    expect(cfg().deprecated).toEqual([]);
    expect(cfg({ CODE_MODEL: "x" }).deprecated).toEqual([]);
  });
});

describe("resolveBudget", () => {
  test("role defaults replace the global cap; MAX_BUDGET_USD is a cap", () => {
    const c = cfg();
    expect([scout, dev].map((r) => resolveBudget(r, {}, c))).toEqual([0.75, 4.5]);
    expect(resolveBudget(dev, {}, cfg({ MAX_BUDGET_USD: "2" }))).toBe(2);
    expect(resolveBudget(scout, {}, cfg({ MAX_BUDGET_USD: "2" }))).toBe(0.75);
  });
  test("env pin; owner raise; the task ceiling limits both", () => {
    expect(resolveBudget(dev, {}, cfg({ BUDGET_DEVELOPER_USD: "4" }))).toBe(4);
    expect(resolveBudget(dev, { extraBudgetUsd: 1.0 }, cfg())).toBe(5.5);
    expect(resolveBudget(dev, { extraBudgetUsd: 3 }, cfg())).toBe(6); // TASK_BUDGET_USD
    expect(resolveBudget(dev, { spentUsd: 4 }, cfg())).toBe(2); // what is left of the task ceiling
  });
});

describe("run options", () => {
  test("roleConfig carries the role's model and budget; runAgent passes model, thinking and the turn ceiling", async () => {
    const sc = roleConfig(dev, cfg());
    expect([sc.model, sc.limits.maxBudgetUsd]).toEqual([SONNET_MODEL, 4.5]);
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
    expect(seen[0]!.maxTurns).toBe(MAX_TURNS);
    expect(seen[1]!.thinking).toEqual({ type: "disabled" });
  });
});
