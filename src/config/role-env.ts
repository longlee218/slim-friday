import { canonicalRoleName } from "../roles/role-aliases";

/* Env of per-role limits: budgets and compact windows. Errors name variables, never values. */

type Env = Record<string, string | undefined>;

/** Accepted COMPACT_WINDOW_* range (tokens): the SDK child takes 100k-1M (P3.0 Q12); 0 = no window var (SDK default window; the 75% share still applies). */
const COMPACT_WINDOW_MIN = 100_000;
const COMPACT_WINDOW_MAX = 1_000_000;

/** What `readRoutingEnv` returns; merged into AgentConfig. */
export interface RoutingEnv {
  /** `<role>` -> USD (BUDGET_<ROLE>_USD). */
  budgetOverrides: Record<string, number>;
  /** `<role>` -> auto-compact window in tokens (COMPACT_WINDOW_<ROLE>; 0 = no window var, SDK default window, 75% share still applies). */
  compactOverrides: Record<string, number>;
  /** Deprecated env names that are set (MODEL and MODEL_<X>: models are fixed per role; the old two-name shapes): the startup warns once, the old shapes are ignored. */
  deprecated: string[];
}

/** Role key of an env var name part: lowercased, an old role name (`BUDGET_DEV_USD`) reads as its current one. */
const roleKey = (part: string): string => canonicalRoleName(part.toLowerCase());

const trimmed = (v: string | undefined): string | undefined => v?.trim() || undefined;

/**
 * Read the per-role limits env. MODEL and MODEL_<X> are gone (models are fixed per role): they are only reported in
 * `deprecated`, so startup warns once. The old shapes with a second name part (BUDGET_<ROLE>_<X>_USD,
 * COMPACT_WINDOW_<ROLE>_<X>) are ignored and reported there too.
 */
export function readRoutingEnv(env: Env): RoutingEnv {
  const budgetOverrides: Record<string, number> = {};
  const compactOverrides: Record<string, number> = {};
  const bad: string[] = [];
  const deprecated: string[] = [];
  for (const [name, raw] of Object.entries(env)) {
    const budget = /^BUDGET_([A-Z0-9]+)_USD$/.exec(name);
    const compact = /^COMPACT_WINDOW_([A-Z0-9]+)$/.exec(name);
    const value = trimmed(raw);
    if (!value) continue;
    // Removed or old shapes: ignored, named once at startup.
    if (
      /^MODEL_[A-Z0-9_]+$/.test(name) ||
      /^BUDGET_[A-Z0-9]+_[A-Z0-9]+_USD$/.test(name) ||
      /^COMPACT_WINDOW_[A-Z0-9]+_[A-Z0-9]+$/.test(name)
    ) {
      deprecated.push(name);
      continue;
    }
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
  return { budgetOverrides, compactOverrides, deprecated };
}
