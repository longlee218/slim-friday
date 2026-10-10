import { DEFAULT_TIER_MODELS, type ModelTier } from "./model-routing";

/* Env of model routing: tier ids, per-stage model pins and per-stage budgets. Errors name variables, never values. */

type Env = Record<string, string | undefined>;

/** What `readRoutingEnv` returns; merged into AgentConfig. */
export interface RoutingEnv {
  /** Tier -> model id (MODEL_HAIKU|SONNET|OPUS over the defaults). */
  models: Record<ModelTier, string>;
  /** `<role>_<stage>` -> tier name or model id (MODEL_<ROLE>_<STAGE>; legacy MODEL / CODE_MODEL fill the gaps). */
  modelOverrides: Record<string, string>;
  /** `<role>_<stage>` -> USD (BUDGET_<ROLE>_<STAGE>_USD). */
  budgetOverrides: Record<string, number>;
  /** Deprecated env names that are set (MODEL, CODE_MODEL): the startup warns once. */
  deprecated: string[];
}

const trimmed = (v: string | undefined): string | undefined => v?.trim() || undefined;

/**
 * Read the routing env. Legacy aliases (kept one release): MODEL pins the assistant `qa` stage, CODE_MODEL (else
 * MODEL, as before) pins both dev stages; a MODEL_<ROLE>_<STAGE> pin wins over an alias.
 */
export function readRoutingEnv(env: Env): RoutingEnv {
  const models = { ...DEFAULT_TIER_MODELS };
  for (const tier of Object.keys(models) as ModelTier[]) {
    const v = trimmed(env[`MODEL_${tier.toUpperCase()}`]);
    if (v) models[tier] = v;
  }
  const modelOverrides: Record<string, string> = {};
  const budgetOverrides: Record<string, number> = {};
  const bad: string[] = [];
  for (const [name, raw] of Object.entries(env)) {
    const model = /^MODEL_([A-Z0-9]+)_([A-Z0-9]+)$/.exec(name);
    const budget = /^BUDGET_([A-Z0-9]+)_([A-Z0-9]+)_USD$/.exec(name);
    const value = trimmed(raw);
    if (model && value) modelOverrides[`${model[1]}_${model[2]}`.toLowerCase()] = value;
    if (budget && value) {
      const usd = Number(raw);
      if (Number.isFinite(usd) && usd > 0)
        budgetOverrides[`${budget[1]}_${budget[2]}`.toLowerCase()] = usd;
      else bad.push(name);
    }
  }
  if (bad.length) throw new Error(`Invalid environment variables: ${bad.join(", ")}`);
  const legacyQa = trimmed(env.MODEL);
  const legacyCode = trimmed(env.CODE_MODEL) ?? legacyQa;
  if (legacyQa) modelOverrides.assistant_qa ??= legacyQa;
  if (legacyCode) {
    modelOverrides.dev_plan ??= legacyCode;
    modelOverrides.dev_exec ??= legacyCode;
  }
  const deprecated = ["MODEL", "CODE_MODEL"].filter((n) => trimmed(env[n]));
  return { models, modelOverrides, budgetOverrides, deprecated };
}
