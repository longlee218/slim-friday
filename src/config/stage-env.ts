import { DEFAULT_TIER_MODELS, type ModelTier } from "./model-routing";

/* Env of model routing: tier ids, per-stage model pins and per-stage budgets. Errors name variables, never values. */

type Env = Record<string, string | undefined>;

/** Accepted COMPACT_WINDOW_* range (tokens): the SDK child takes 100k-1M (P3.0 Q12); 0 = off (SDK default). */
export const COMPACT_WINDOW_MIN = 100_000;
export const COMPACT_WINDOW_MAX = 1_000_000;

/** What `readRoutingEnv` returns; merged into AgentConfig. */
export interface RoutingEnv {
  /** Tier -> model id (MODEL_HAIKU|SONNET|OPUS over the defaults). */
  models: Record<ModelTier, string>;
  /** `<role>_<stage>` -> tier name or model id (MODEL_<ROLE>_<STAGE>; the legacy MODEL alias fills the assistant `qa` gap). */
  modelOverrides: Record<string, string>;
  /** `<role>_<stage>` -> USD (BUDGET_<ROLE>_<STAGE>_USD). */
  budgetOverrides: Record<string, number>;
  /** `<role>_<stage>` -> auto-compact window in tokens (COMPACT_WINDOW_<ROLE>_<STAGE>; 0 = leave the SDK default). */
  compactOverrides: Record<string, number>;
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
  const compactOverrides: Record<string, number> = {};
  const bad: string[] = [];
  for (const [name, raw] of Object.entries(env)) {
    const model = /^MODEL_([A-Z0-9]+)_([A-Z0-9]+)$/.exec(name);
    const budget = /^BUDGET_([A-Z0-9]+)_([A-Z0-9]+)_USD$/.exec(name);
    const compact = /^COMPACT_WINDOW_([A-Z0-9]+)_([A-Z0-9]+)$/.exec(name);
    const value = trimmed(raw);
    if (model && value) modelOverrides[`${model[1]}_${model[2]}`.toLowerCase()] = value;
    if (budget && value) {
      const usd = Number(raw);
      if (Number.isFinite(usd) && usd > 0)
        budgetOverrides[`${budget[1]}_${budget[2]}`.toLowerCase()] = usd;
      else bad.push(name);
    }
    if (compact && value) {
      const tokens = Number(raw);
      const inRange = tokens >= COMPACT_WINDOW_MIN && tokens <= COMPACT_WINDOW_MAX;
      if (Number.isInteger(tokens) && (tokens === 0 || inRange))
        compactOverrides[`${compact[1]}_${compact[2]}`.toLowerCase()] = tokens;
      else bad.push(name);
    }
  }
  if (bad.length) throw new Error(`Invalid environment variables: ${bad.join(", ")}`);
  const legacyQa = trimmed(env.MODEL);
  if (legacyQa) modelOverrides.assistant_qa ??= legacyQa;
  const deprecated = ["MODEL"].filter((n) => trimmed(env[n]));
  return { models, modelOverrides, budgetOverrides, compactOverrides, deprecated };
}
