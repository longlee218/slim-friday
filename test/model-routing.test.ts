import { describe, expect, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../src/config/agent-config";
import { effortKnobs, MAX_TURNS } from "../src/config/effort-mapping";
import {
  DEFAULT_TIER_MODELS,
  effortTier,
  resolveBudget,
  resolveModel,
  safeEffort,
} from "../src/config/model-routing";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { roleConfig } from "../src/runtime/sdk-options";
import { makeEnv, resultMsg } from "./helpers";

const cfg = (extra: Record<string, string> = {}) => loadConfig({ AGENT_HOME: "/h", ...extra });
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
  test("MODEL_<ROLE>, BUDGET_<ROLE>_USD and COMPACT_WINDOW_<ROLE> are collected; bad names the var; tier ids and MODEL_INTENT are no role pins", () => {
    const c = cfg({
      MODEL_DEV: "opus",
      BUDGET_DEV_USD: "5",
      COMPACT_WINDOW_DEV: "200000",
      MODEL_INTENT: "x",
    });
    expect(c.modelOverrides).toEqual({ dev: "opus" });
    expect(c.budgetOverrides.dev).toBe(5);
    expect(c.compactOverrides.dev).toBe(200000);
    expect(() => cfg({ BUDGET_DEV_USD: "abc" })).toThrow("BUDGET_DEV_USD");
    expect(cfg({ MODEL_SONNET: "s" }).modelOverrides).toEqual({});
  });
  test("old per-stage shapes (MODEL_<ROLE>_<X>, BUDGET_<ROLE>_<X>_USD, COMPACT_WINDOW_<ROLE>_<X>) are ignored and reported as deprecated", () => {
    const c = cfg({
      MODEL_DEV_PLAN: "opus",
      BUDGET_DEV_EXEC_USD: "5",
      COMPACT_WINDOW_DEV_EXEC: "200000",
    });
    expect(c.deprecated.sort()).toEqual([
      "BUDGET_DEV_EXEC_USD",
      "COMPACT_WINDOW_DEV_EXEC",
      "MODEL_DEV_PLAN",
    ]);
    expect([c.modelOverrides, c.budgetOverrides, c.compactOverrides]).toEqual([{}, {}, {}]);
    expect(resolveBudget(dev, {}, c)).toBe(4.5); // the old budget did not apply
  });
  test("legacy MODEL alias pins no role (Anthropic path): flagged deprecated; MODEL_<ROLE> pins stay", () => {
    const c = cfg({ MODEL: "m-qa", MODEL_DEV: "sonnet" });
    expect(c.deprecated).toEqual(["MODEL"]);
    expect(c.modelOverrides).toEqual({ dev: "sonnet" });
    expect(resolveModel(assistant, {}, c)).toBe(H); // the role's own model, not MODEL
    expect(resolveModel(dev, {}, c)).toBe(S);
    expect(cfg({ MODEL: "m-qa", MODEL_ASSISTANT: "opus" }).modelOverrides.assistant).toBe("opus");
    expect(cfg().deprecated).toEqual([]);
    // CODE_MODEL is ignored now.
    expect(cfg({ CODE_MODEL: "x" }).deprecated).toEqual([]);
  });
});

describe("resolveModel", () => {
  const c = cfg();
  test("default map: assistant haiku; dev sonnet (opus for design)", () => {
    expect(resolveModel(assistant, {}, c)).toBe(H);
    expect(resolveModel(dev, { cls: "standard" }, c)).toBe(S);
    expect(resolveModel(dev, { cls: "mechanical" }, c)).toBe(S);
    expect(resolveModel(dev, {}, c)).toBe(S); // missing class = standard
    expect(resolveModel(dev, { cls: "design" }, c)).toBe(O);
  });
  test("class never moves the assistant (no class tiers)", () => {
    expect(resolveModel(assistant, { cls: "design" }, c)).toBe(H);
  });
  test("effort: low haiku, medium sonnet, high by class, max opus", () => {
    expect(effortTier("low")).toBe("haiku");
    expect(effortTier("medium")).toBe("sonnet");
    expect(effortTier("high", "standard")).toBe("sonnet");
    expect(effortTier("high", "design")).toBe("opus");
    expect(effortTier("max")).toBe("opus");
    expect(resolveModel(dev, { cls: "standard", effort: "low" }, c)).toBe(H);
    expect(resolveModel(assistant, { effort: "medium" }, c)).toBe(S);
  });
  test("precedence: env pin > forced tier > effort > class", () => {
    expect(resolveModel(assistant, { tier: "sonnet", effort: "low" }, c)).toBe(S);
    expect(resolveModel(assistant, { tier: "sonnet" }, cfg({ MODEL_ASSISTANT: "opus" }))).toBe(O);
    expect(resolveModel(dev, { cls: "design" }, cfg({ MODEL_DEV: "claude-x" }))).toBe("claude-x");
  });
  test("openrouter: tiers unused; env pin > the role's openrouterModel > the one default model", () => {
    const key = `sk-or-v1-${"a1b2c3d4".repeat(8)}`;
    const or = cfg({ OPENROUTER_API_KEY: key });
    expect(resolveModel(assistant, { tier: "opus" }, or)).toBe(or.model);
    expect(resolveModel(dev, { cls: "design" }, or)).toBe("anthropic/claude-haiku-4.5");
    const pinned = cfg({ OPENROUTER_API_KEY: key, MODEL_DEV: "x/y" });
    expect(resolveModel(dev, {}, pinned)).toBe("x/y");
    expect(resolveModel(assistant, {}, pinned)).toBe(pinned.model);
  });
});

describe("resolveBudget", () => {
  test("role defaults replace the global cap; MAX_BUDGET_USD is a cap", () => {
    const c = cfg();
    expect([assistant, dev].map((r) => resolveBudget(r, {}, c))).toEqual([1, 4.5]);
    expect(resolveBudget(dev, {}, cfg({ MAX_BUDGET_USD: "2" }))).toBe(2);
    expect(resolveBudget(assistant, {}, cfg({ MAX_BUDGET_USD: "2" }))).toBe(1);
  });
  test("escalated assistant 2.5; env pin; owner raise; the task ceiling limits both", () => {
    expect(resolveBudget(assistant, { escalated: true }, cfg())).toBe(2.5);
    expect(resolveBudget(dev, {}, cfg({ BUDGET_DEV_USD: "4" }))).toBe(4);
    expect(resolveBudget(dev, { extraBudgetUsd: 1.0 }, cfg())).toBe(5.5);
    expect(resolveBudget(dev, { extraBudgetUsd: 3 }, cfg())).toBe(6); // TASK_BUDGET_USD
    expect(resolveBudget(dev, { spentUsd: 4 }, cfg())).toBe(2); // what is left of the task ceiling
  });
  test("openrouter: only the global cap", () => {
    const or = cfg({ OPENROUTER_API_KEY: `sk-or-v1-${"a1b2c3d4".repeat(8)}` });
    expect(resolveBudget(dev, {}, or)).toBeUndefined();
    expect(resolveBudget(dev, {}, { ...or, limits: { ...or.limits, maxBudgetUsd: 2 } })).toBe(2);
  });
});

describe("opus guard (defense in depth)", () => {
  const c = cfg();
  test("effort max / tier opus resolve to Opus only with ownerConfirmedMax; else capped at high", () => {
    expect(resolveModel(assistant, { effort: "max" }, c)).toBe(S);
    expect(resolveModel(assistant, { effort: "max", ownerConfirmedMax: true }, c)).toBe(O);
    expect(resolveModel(assistant, { tier: "opus" }, c)).toBe(S);
    expect(resolveModel(assistant, { tier: "opus", ownerConfirmedMax: true }, c)).toBe(O);
    // design: the cap is the high tier of the class (opus already by the table)
    expect(resolveModel(dev, { cls: "design", effort: "max" }, c)).toBe(O);
  });
  test("table default stays: dev design is opus without the flag", () => {
    expect(resolveModel(dev, { cls: "design" }, c)).toBe(O);
  });
  test("max thinking knobs are capped to high without the flag", () => {
    expect(safeEffort({ effort: "max" })).toBe("high");
    expect(safeEffort({ effort: "max", ownerConfirmedMax: true })).toBe("max");
    expect(safeEffort({})).toBeUndefined();
  });
  test("tier lookup ignores prototype keys", () => {
    expect(resolveModel(assistant, {}, cfg({ MODEL_ASSISTANT: "constructor" }))).toBe(
      "constructor",
    );
  });
});

describe("effort knobs", () => {
  test("thinking and maxTurns per level: MAX_TURNS is an absolute ceiling", () => {
    expect(effortKnobs("low")).toEqual({ thinking: { type: "disabled" }, maxTurns: 10 });
    expect(effortKnobs("medium")).toEqual({ thinking: { type: "adaptive" }, maxTurns: 20 });
    expect(effortKnobs("high")).toEqual({
      thinking: { type: "enabled", budgetTokens: 16000 },
      maxTurns: 20,
    });
    for (const e of ["low", "medium", "high", "max"] as const)
      expect(effortKnobs(e).maxTurns).toBeLessThanOrEqual(MAX_TURNS);
    expect(MAX_TURNS).toBe(20);
  });
  test("roleConfig carries model and budget; runAgent options carry effort knobs only when asked", async () => {
    const sc = roleConfig(dev, cfg(), { cls: "design" });
    expect([sc.model, sc.limits.maxBudgetUsd]).toEqual([O, 4.5]);
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
        turnId: "t",
        role: assistant,
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
    expect(seen[1]!.maxTurns).toBe(MAX_TURNS); // ceiling, even for effort high
    expect(seen[1]!.model).toBe(S);
  });
});
