import { describe, expect, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../src/config/agent-config";
import { effortKnobs } from "../src/config/effort-mapping";
import {
  DEFAULT_TIER_MODELS,
  effortTier,
  resolveBudget,
  resolveModel,
  safeEffort,
} from "../src/config/model-routing";
import { getRole, getStage } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { stageConfig } from "../src/runtime/sdk-options";
import { makeEnv, resultMsg } from "./helpers";

const cfg = (extra: Record<string, string> = {}) => loadConfig({ AGENT_HOME: "/h", ...extra });
const qa = getStage("assistant", "qa");
const plan = getStage("dev", "plan");
const exec = getStage("dev", "exec");
const assistant = getRole("assistant");
const dev = getRole("dev");
const H = DEFAULT_TIER_MODELS.haiku;
const S = DEFAULT_TIER_MODELS.sonnet;
const O = DEFAULT_TIER_MODELS.opus;

describe("tier defaults and env", () => {
  test("default ids per tier; MODEL_<TIER> overrides one", () => {
    expect(cfg().models).toEqual({ haiku: H, sonnet: S, opus: O });
    expect(cfg({ MODEL_OPUS: "claude-opus-x" }).models).toEqual({
      haiku: H,
      sonnet: S,
      opus: "claude-opus-x",
    });
  });
  test("compaction model follows the haiku tier on Anthropic; MEMORY_MODEL wins", () => {
    expect(cfg().memoryModel).toBe(H);
    expect(cfg({ MODEL_HAIKU: "h2" }).memoryModel).toBe("h2");
    expect(cfg({ MODEL_HAIKU: "h2", MEMORY_MODEL: "m" }).memoryModel).toBe("m");
  });
  test("MODEL_<ROLE>_<STAGE> and BUDGET_<ROLE>_<STAGE>_USD are collected; bad budget names the var", () => {
    const c = cfg({ MODEL_DEV_PLAN: "opus", BUDGET_DEV_EXEC_USD: "5" });
    expect(c.modelOverrides.dev_plan).toBe("opus");
    expect(c.budgetOverrides.dev_exec).toBe(5);
    expect(() => cfg({ BUDGET_DEV_EXEC_USD: "abc" })).toThrow("BUDGET_DEV_EXEC_USD");
  });
  test("legacy MODEL / CODE_MODEL: aliases, kept, flagged deprecated; the new pin wins", () => {
    const c = cfg({ MODEL: "m-qa", CODE_MODEL: "m-code", MODEL_DEV_EXEC: "sonnet" });
    expect(c.deprecated).toEqual(["MODEL", "CODE_MODEL"]);
    expect(resolveModel(qa, assistant, {}, c)).toBe("m-qa");
    expect(resolveModel(plan, dev, {}, c)).toBe("m-code");
    expect(resolveModel(exec, dev, {}, c)).toBe(S);
    expect(cfg().deprecated).toEqual([]);
    // MODEL alone also pins code stages (old behavior: codeModel defaulted to MODEL).
    expect(resolveModel(plan, dev, {}, cfg({ MODEL: "only" }))).toBe("only");
  });
});

describe("resolveModel", () => {
  const c = cfg();
  test("default map: qa haiku; plan sonnet (opus for design); exec by class", () => {
    expect(resolveModel(qa, assistant, {}, c)).toBe(H);
    expect(resolveModel(plan, dev, { cls: "standard" }, c)).toBe(S);
    expect(resolveModel(plan, dev, { cls: "mechanical" }, c)).toBe(S);
    expect(resolveModel(plan, dev, { cls: "design" }, c)).toBe(O);
    expect(resolveModel(exec, dev, { cls: "mechanical" }, c)).toBe(H);
    expect(resolveModel(exec, dev, {}, c)).toBe(S); // missing class = standard
    expect(resolveModel(exec, dev, { cls: "design" }, c)).toBe(O);
  });
  test("class never moves qa (no modelTiers)", () => {
    expect(resolveModel(qa, assistant, { cls: "design" }, c)).toBe(H);
  });
  test("effort: low haiku, medium sonnet, high by class, max opus", () => {
    expect(effortTier("low")).toBe("haiku");
    expect(effortTier("medium")).toBe("sonnet");
    expect(effortTier("high", "standard")).toBe("sonnet");
    expect(effortTier("high", "design")).toBe("opus");
    expect(effortTier("max")).toBe("opus");
    expect(resolveModel(exec, dev, { cls: "standard", effort: "low" }, c)).toBe(H);
    expect(resolveModel(qa, assistant, { effort: "medium" }, c)).toBe(S);
  });
  test("precedence: env pin > forced tier > effort > class", () => {
    expect(resolveModel(qa, assistant, { tier: "sonnet", effort: "low" }, c)).toBe(S);
    expect(
      resolveModel(qa, assistant, { tier: "sonnet" }, cfg({ MODEL_ASSISTANT_QA: "opus" })),
    ).toBe(O);
    expect(resolveModel(plan, dev, { cls: "design" }, cfg({ MODEL_DEV_PLAN: "claude-x" }))).toBe(
      "claude-x",
    );
  });
  test("openrouter: tiers unused, legacy slots kept", () => {
    const or = cfg({ OPENROUTER_API_KEY: `sk-or-v1-${"a1b2c3d4".repeat(8)}` });
    expect(resolveModel(qa, assistant, { tier: "opus" }, or)).toBe(or.model);
    expect(resolveModel(exec, dev, { cls: "design" }, or)).toBe(or.codeModel);
  });
});

describe("resolveBudget", () => {
  test("stage defaults replace the global 0.5; MAX_BUDGET_USD is a cap", () => {
    const c = cfg();
    expect(
      [qa, plan, exec].map((s) => resolveBudget(s, getRole(s === qa ? "assistant" : "dev"), {}, c)),
    ).toEqual([0.5, 1.5, 3]);
    expect(resolveBudget(exec, dev, {}, cfg({ MAX_BUDGET_USD: "2" }))).toBe(2);
    expect(resolveBudget(qa, assistant, {}, cfg({ MAX_BUDGET_USD: "2" }))).toBe(0.5);
  });
  test("escalated qa 1.5; env pin; owner raise", () => {
    expect(resolveBudget(qa, assistant, { escalated: true }, cfg())).toBe(1.5);
    expect(resolveBudget(exec, dev, {}, cfg({ BUDGET_DEV_EXEC_USD: "4" }))).toBe(4);
    expect(resolveBudget(exec, dev, { extraBudgetUsd: 1.5 }, cfg())).toBe(4.5);
  });
  test("openrouter: only the global cap", () => {
    const or = cfg({ OPENROUTER_API_KEY: `sk-or-v1-${"a1b2c3d4".repeat(8)}` });
    expect(resolveBudget(exec, dev, {}, or)).toBeUndefined();
    expect(resolveBudget(exec, dev, {}, { ...or, limits: { ...or.limits, maxBudgetUsd: 2 } })).toBe(
      2,
    );
  });
});

describe("opus guard (defense in depth)", () => {
  const c = cfg();
  test("effort max / tier opus resolve to Opus only with ownerConfirmedMax; else capped at high", () => {
    expect(resolveModel(qa, assistant, { effort: "max" }, c)).toBe(S);
    expect(resolveModel(qa, assistant, { effort: "max", ownerConfirmedMax: true }, c)).toBe(O);
    expect(resolveModel(qa, assistant, { tier: "opus" }, c)).toBe(S);
    expect(resolveModel(qa, assistant, { tier: "opus", ownerConfirmedMax: true }, c)).toBe(O);
    // design: the cap is the high tier of the class (opus already by the table)
    expect(resolveModel(plan, dev, { cls: "design", effort: "max" }, c)).toBe(O);
  });
  test("table defaults stay: dev plan design and exec design are opus without the flag", () => {
    expect(resolveModel(plan, dev, { cls: "design" }, c)).toBe(O);
    expect(resolveModel(exec, dev, { cls: "design" }, c)).toBe(O);
  });
  test("max thinking knobs are capped to high without the flag", () => {
    expect(safeEffort({ effort: "max" })).toBe("high");
    expect(safeEffort({ effort: "max", ownerConfirmedMax: true })).toBe("max");
    expect(safeEffort({})).toBeUndefined();
  });
  test("tier lookup ignores prototype keys", () => {
    expect(resolveModel(qa, assistant, {}, cfg({ MODEL_ASSISTANT_QA: "constructor" }))).toBe(
      "constructor",
    );
  });
});

describe("effort knobs", () => {
  test("thinking and maxTurns per level (base 20)", () => {
    expect(effortKnobs("low", 20)).toEqual({ thinking: { type: "disabled" }, maxTurns: 10 });
    expect(effortKnobs("medium", 20)).toEqual({ thinking: { type: "adaptive" }, maxTurns: 20 });
    expect(effortKnobs("high", 20)).toEqual({
      thinking: { type: "enabled", budgetTokens: 16000 },
      maxTurns: 30,
    });
    expect(effortKnobs("max", 20).maxTurns).toBe(40);
    expect(effortKnobs("low", 1).maxTurns).toBe(1);
  });
  test("stageConfig carries model and budget; runAgent options carry effort knobs only when asked", async () => {
    const sc = stageConfig(exec, cfg(), { cls: "design" });
    expect([sc.model, sc.limits.maxBudgetUsd]).toEqual([O, 3]);
    const env = makeEnv();
    const seen: Options[] = [];
    const queryFn = (a: { options?: Options }) =>
      (async function* () {
        seen.push(a.options as Options);
        yield resultMsg();
      })();
    const run = (route?: object) =>
      runAgent({
        prompt: "q",
        taskId: "t",
        cwd: env.home,
        config: env.config,
        db: env.db,
        abortController: new AbortController(),
        queryFn: queryFn as never,
        route,
      });
    await run();
    await run({ effort: "high", tier: "sonnet" });
    expect("thinking" in seen[0]!).toBe(false);
    expect(seen[0]!.model).toBe(H);
    expect(seen[1]!.thinking).toEqual({ type: "enabled", budgetTokens: 16000 });
    expect(seen[1]!.maxTurns).toBe(30);
    expect(seen[1]!.model).toBe(S);
  });
});
