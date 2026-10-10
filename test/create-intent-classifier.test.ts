import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config/agent-config";
import { createIntentClassifier } from "../src/intent/create-intent-classifier";
import { buildIntentDeps } from "../src/intent/intent-deps";
import { lexiconOverrideFile } from "../src/intent/load-lexicon";
import { makeEnv } from "./helpers";

const base = { AGENT_HOME: "/tmp/x" };

test("config defaults: haiku engine, haiku tier, 0.02 USD, 8000 ms", () => {
  const c = loadConfig(base);
  expect(c.intent).toEqual({
    engine: "haiku",
    model: c.models.haiku,
    budgetUsd: 0.02,
    timeoutMs: 8000,
  });
});

test("config: engines haiku | jev | none; unknown engine, timeout < 8000 and a bad budget fail at startup (names only)", () => {
  for (const e of ["haiku", "jev", "none"])
    expect(loadConfig({ ...base, INTENT_ENGINE: e }).intent.engine).toBe(e as never);
  for (const bad of [
    { INTENT_ENGINE: "gpt" },
    { INTENT_TIMEOUT_MS: "5000" },
    { INTENT_BUDGET_USD: "0" },
    { INTENT_BUDGET_USD: "abc" },
  ]) {
    const key = Object.keys(bad)[0]!;
    expect(() => loadConfig({ ...base, ...bad })).toThrow(`Invalid environment variables: ${key}`);
  }
  expect(
    loadConfig({ ...base, INTENT_TIMEOUT_MS: "12000", INTENT_BUDGET_USD: "0.05" }).intent,
  ).toMatchObject({
    timeoutMs: 12000,
    budgetUsd: 0.05,
  });
});

test("openrouter: MODEL_INTENT is an id as is; the default is a Haiku id", () => {
  const or = { ...base, LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-x" };
  expect(loadConfig(or).intent.model).toBe("anthropic/claude-haiku-4.5");
  expect(loadConfig({ ...or, MODEL_INTENT: "haiku" }).intent.model).toBe("haiku");
});

test("factory: haiku -> classifier, none -> undefined (L0-L3 only), jev -> throws (no stub)", () => {
  const mk = (INTENT_ENGINE: string) => loadConfig({ ...base, INTENT_ENGINE });
  expect(typeof createIntentClassifier(mk("haiku"))?.classify).toBe("function");
  expect(createIntentClassifier(mk("none"))).toBeUndefined();
  expect(() => createIntentClassifier(mk("jev"))).toThrow("INTENT_ENGINE=jev");
});

test("startup wiring: builds pipeline + engine; an invalid lexicon override or jev refuses", () => {
  const env = makeEnv();
  const deps = buildIntentDeps(env.config);
  expect(deps.pipeline.lexicon.groups.length).toBeGreaterThan(3);
  expect(deps.classifier).toBeDefined();
  expect(
    buildIntentDeps({ ...env.config, intent: { ...env.config.intent, engine: "none" } }).classifier,
  ).toBeUndefined();
  expect(() =>
    buildIntentDeps({ ...env.config, intent: { ...env.config.intent, engine: "jev" } }),
  ).toThrow("jev");
  writeFileSync(lexiconOverrideFile(env.home), "groups: [not, a, map]\n");
  expect(() => buildIntentDeps(env.config)).toThrow(lexiconOverrideFile(env.home));
});
