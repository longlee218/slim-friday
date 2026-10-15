import { canonicalRoleName } from "../roles/role-aliases";
import { DEFAULT_TIER_MODELS, type ModelTier } from "./model-routing";

/* Env of model routing: tier ids, per-role model pins, budgets and compact windows. Errors name variables, never values. */

type Env = Record<string, string | undefined>;

/** Accepted COMPACT_WINDOW_* range (tokens): the SDK child takes 100k-1M (P3.0 Q12); 0 = no window var (SDK default window; the 75% share still applies). */
export const COMPACT_WINDOW_MIN = 100_000;
export const COMPACT_WINDOW_MAX = 1_000_000;

/** `MODEL_<X>` names that are not a role pin: the tier ids and the intent model. */
const NOT_A_ROLE = new Set(["HAIKU", "SONNET", "OPUS", "INTENT"]);

/** What `readRoutingEnv` returns; merged into AgentConfig. */
export interface RoutingEnv {
  /** Tier -> model id (MODEL_HAIKU|SONNET|OPUS over the defaults). */
  models: Record<ModelTier, string>;
  /** `<role>` -> tier name or model id (MODEL_<ROLE>). */
  modelOverrides: Record<string, string>;
  /** `<role>` -> USD (BUDGET_<ROLE>_USD). */
  budgetOverrides: Record<string, number>;
  /** `<role>` -> auto-compact window in tokens (COMPACT_WINDOW_<ROLE>; 0 = no window var, SDK default window, 75% share still applies). */
  compactOverrides: Record<string, number>;
  /** Deprecated env names that are set (legacy MODEL, the old two-name shapes): the startup warns once, the old shapes are ignored. */
  deprecated: string[];
}

/** Role key of an env var name part: lowercased, an old role name (`MODEL_DEV`) reads as its current one. */
const roleKey = (part: string): string => canonicalRoleName(part.toLowerCase());

const trimmed = (v: string | undefined): string | undefined => v?.trim() || undefined;

/**
 * Read the routing env. The MODEL var is gone (it is only reported in `deprecated`, so startup warns once). The old shapes with a second name
 * part (MODEL_<ROLE>_<X>, BUDGET_<ROLE>_<X>_USD, COMPACT_WINDOW_<ROLE>_<X>) are ignored and reported in `deprecated`.
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
  const deprecated: string[] = [];
  for (const [name, raw] of Object.entries(env)) {
    const model = /^MODEL_([A-Z0-9]+)$/.exec(name);
    const budget = /^BUDGET_([A-Z0-9]+)_USD$/.exec(name);
    const compact = /^COMPACT_WINDOW_([A-Z0-9]+)$/.exec(name);
    const value = trimmed(raw);
    if (!value) continue;
    // Old shapes with a second name part: ignored, named once at startup.
    if (
      /^MODEL_[A-Z0-9]+_[A-Z0-9]+$/.test(name) ||
      /^BUDGET_[A-Z0-9]+_[A-Z0-9]+_USD$/.test(name) ||
      /^COMPACT_WINDOW_[A-Z0-9]+_[A-Z0-9]+$/.test(name)
    ) {
      deprecated.push(name);
      continue;
    }
    if (model && !NOT_A_ROLE.has(model[1])) modelOverrides[roleKey(model[1])] = value;
    if (budget) {
      const usd = Number(raw);
      if (Number.isFinite(usd) && usd > 0) budgetOverrides[roleKey(budget[1])] = usd;
      else bad.push(name);
    }
    if (compact) {
      const tokens = Number(raw);
      const inRange = tokens >= COMPACT_WINDOW_MIN && tokens <= COMPACT_WINDOW_MAX;
      if (Number.isInteger(tokens) && (tokens === 0 || inRange))
        compactOverrides[roleKey(compact[1])] = tokens;
      else bad.push(name);
    }
  }
  if (bad.length) throw new Error(`Invalid environment variables: ${bad.join(", ")}`);
  if (trimmed(env.MODEL)) deprecated.push("MODEL"); // removed var: only the startup warning remains
  return { models, modelOverrides, budgetOverrides, compactOverrides, deprecated };
}
