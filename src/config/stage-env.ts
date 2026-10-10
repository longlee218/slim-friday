import { DEFAULT_TIER_MODELS, type ModelTier } from "./model-routing";

/* Env of model routing: tier ids, per-stage model pins and per-stage budgets. Errors name variables, never values. */

type Env = Record<string, string | undefined>;

/** What `readRoutingEnv` returns; merged into AgentConfig. */
export interface RoutingEnv {
  /** Tier -> model id (MODEL_HAIKU|SONNET|OPUS over the defaults). */
  models: Record<ModelTier, string>;
  /** `<role>_<stage>` -> tier name or model id (MODEL_<ROLE>_<STAGE>; the legacy MODEL alias fills the assistant `qa` gap). */
  modelOverrides: Record<string, string>;
  /** `<role>_<stage>` -> USD (BUDGET_<ROLE>_<STAGE>_USD). */
  budgetOverrides: Record<string, number>;
  /** Deprecated env names that are set (MODEL): the startup warns once. */
  deprecated: string[];
}

const trimmed = (v: string | undefined): string | undefined => v?.trim() || undefined;

/**
 * Read the routing env. The legacy MODEL alias is KEPT on purpose (the owner's real .env still sets it): it pins
 * the assistant `qa` stage and warns once at startup. A MODEL_<ROLE>_<STAGE> pin wins over it.
 * (The old code-model alias and MODEL's side effect of pinning both dev stages are removed.)
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
  if (legacyQa) modelOverrides.assistant_qa ??= legacyQa;
  const deprecated = ["MODEL"].filter((n) => trimmed(env[n]));
  return { models, modelOverrides, budgetOverrides, deprecated };
}
