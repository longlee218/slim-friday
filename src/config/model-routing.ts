import type { RoleDefinition } from "../roles/role-types";
import { COMPACT_WINDOW_TOKENS } from "../runtime/sdk-env";
import type { AgentConfig } from "./agent-config";

/* Model tiers and per-role budgets: WHICH model a role run uses and HOW MUCH it may spend. Pure functions. */

/** Cost/ability tiers; the ids behind them live in `config.models` (env MODEL_HAIKU|SONNET|OPUS). */
export type ModelTier = "haiku" | "sonnet" | "opus";

/** Size of a task: mechanical = simple edits/docs, design = architecture/strategy/UI-UX. */
export type TaskClass = "mechanical" | "standard" | "design";

/** Effort hint: maps to model tier, thinking, budget share and maxTurns (see effort-mapping.ts). */
export type Effort = "low" | "medium" | "high" | "max";

/** Default ids per tier (owner, Rev 2 #1). */
export const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

/** Per-run routing facts the orchestrator knows; every field is optional (missing = role defaults). */
export interface Route {
  /** Task class (intent layer or owner prefix); missing = `standard`. */
  cls?: TaskClass;
  /** Effort hint; missing = derive everything from the class table. */
  effort?: Effort;
  /** Forced tier (the lead's escalated re-run); beats class and effort. */
  tier?: ModelTier;
  /**
   * Trusted internal note for a NEW query (never shown to the owner, never part of the user prompt or a steer): the
   * fallback re-run's "previous attempt failed" note and the run supervisor's recovery hint. It goes into the system context.
   */
  internalHint?: string;
  /** Owner raised the budget (`go +<usd>`, parsed in P1.4): added to the role budget. */
  extraBudgetUsd?: number;
  /** USD the task's earlier runs (itself and the runs it resumes) already cost; the task ceiling `TASK_BUDGET_USD` is shared with them. */
  spentUsd?: number;
  /** Owner explicitly confirmed `max` / Opus for this run; without it an escalation- or effort-driven opus is capped at high. */
  ownerConfirmedMax?: boolean;
}

/** Effort -> tier. `high` follows the class (Opus only for design); `max` is always Opus (owner-confirmed upstream). */
export function effortTier(effort: Effort, cls: TaskClass = "standard"): ModelTier {
  if (effort === "low") return "haiku";
  if (effort === "medium") return "sonnet";
  if (effort === "max") return "opus";
  return cls === "design" ? "opus" : "sonnet";
}

/** Per-task spend ceiling (USD) over the task's runs (resumes and `/go +usd` re-runs included): a run gets at most what is left of it (owner, Rev 14 addendum 2). */
export const TASK_BUDGET_USD = 6.0;

/** Tier name -> configured id; anything else is an explicit model id and passes through. */
export function specToId(spec: string, config: Pick<AgentConfig, "models">): string {
  return Object.hasOwn(config.models, spec) ? config.models[spec as ModelTier] : spec;
}

/** Effort of a run with `max` capped at `high` unless the owner confirmed (defense in depth; knobs and tier use it). */
export function safeEffort(route: Route): Effort | undefined {
  return route.effort === "max" && !route.ownerConfirmedMax ? "high" : route.effort;
}

/** Env override key of a role: `dev` for MODEL_DEV / BUDGET_DEV_USD / COMPACT_WINDOW_DEV. */
export const roleKey = (role: string): string => role.toLowerCase();

/**
 * Model id of a role run. Anthropic path order: env pin (MODEL_<ROLE>) >
 * forced tier > effort > the role's `classTiers` > the role's own `model`.
 * OpenRouter: tiers are not used; env pin (used as the model id) > the role's `openrouterModel` > `config.model`.
 */
export function resolveModel(role: RoleDefinition, route: Route, config: AgentConfig): string {
  const pin = config.modelOverrides[roleKey(role.name)];
  if (config.provider === "openrouter") return pin ?? role.openrouterModel ?? config.model;
  if (pin) return specToId(pin, config);
  const cls = route.cls ?? "standard";
  // Opus from a forced tier needs the owner's confirmation; else it is capped at the high tier (class table).
  if (route.tier)
    return config.models[
      route.tier === "opus" && !route.ownerConfirmedMax ? effortTier("high", cls) : route.tier
    ];
  const effort = safeEffort(route);
  if (effort) return config.models[effortTier(effort, cls)];
  return specToId(role.classTiers?.[cls] ?? role.model, config);
}

/** True when a run's budget cap IS what the task's earlier runs left of the ceiling (so a raise cannot help). */
export const ceilingBinds = (limitUsd: number | undefined, spentUsd = 0): boolean =>
  limitUsd !== undefined && spentUsd > 0 && Math.abs(limitUsd + spentUsd - TASK_BUDGET_USD) < 1e-6;

/**
 * Budget (USD) of a role run, or undefined = no cap. Anthropic: env pin BUDGET_<ROLE>_USD > the role's default
 * plus any owner raise, limited to what is left of
 * TASK_BUDGET_USD, then capped by MAX_BUDGET_USD.
 * OpenRouter has no role budget (SDK prices cost from Anthropic tables): only MAX_BUDGET_USD applies.
 */
export function resolveBudget(
  role: RoleDefinition,
  route: Route,
  config: AgentConfig,
): number | undefined {
  const cap = config.limits.maxBudgetUsd;
  if (config.provider === "openrouter") return cap;
  const pin = config.budgetOverrides[roleKey(role.name)];
  const base = pin ?? role.budgetUsd;
  // Task ceiling: the run gets at most what the task's earlier runs left of TASK_BUDGET_USD. An owner raise
  // (`go +usd`) widens the role budget only, never the ceiling (a hard per-task cost cap by design).
  const left = Math.max(0, TASK_BUDGET_USD - (route.spentUsd ?? 0));
  const total = Math.min(base + (route.extraBudgetUsd ?? 0), left);
  return cap === undefined ? total : Math.min(total, cap);
}

/**
 * Auto-compact window (tokens) the orchestrator sets for a role run. Env pin COMPACT_WINDOW_<ROLE> (0 = no window
 * var, the SDK default window; the 75% share still applies) > the role's `autoCompactWindow` > the app default
 * `COMPACT_WINDOW_TOKENS`. Never read from the owner's shell by the SDK child: only this value reaches it.
 */
export function resolveCompactWindow(role: RoleDefinition, config: AgentConfig): number {
  const pin = config.compactOverrides[roleKey(role.name)];
  return pin ?? role.autoCompactWindow ?? COMPACT_WINDOW_TOKENS;
}
