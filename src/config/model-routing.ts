import type { RoleDefinition, StageDefinition } from "../roles/role-types";
import type { AgentConfig } from "./agent-config";

/* Model tiers and per-stage budgets: WHICH model a stage runs on and HOW MUCH it may spend. Pure functions. */

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

/** Per-run routing facts the orchestrator knows; every field is optional (missing = stage defaults). */
export interface Route {
  /** Task class (intent layer or owner prefix); missing = `standard`. */
  cls?: TaskClass;
  /** Effort hint; missing = derive everything from the class table. */
  effort?: Effort;
  /** Forced tier (Haiku triage escalation re-run); beats class and effort. */
  tier?: ModelTier;
  /** This run is an escalated answer re-run: uses the stage's larger `escalatedBudgetUsd`. */
  escalated?: boolean;
  /** First answer run: tell the model it may end with `ESCALATE: sonnet|opus` (see qa-escalation.ts). */
  offerEscalation?: boolean;
  /** Owner raised the budget (`go +<usd>`, parsed in P1.4): added to the stage budget. */
  extraBudgetUsd?: number;
  /** USD the task's OTHER stages already cost (stage rows); the task ceiling `TASK_BUDGET_USD` is shared with them. */
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

/** Per-task spend ceiling (USD) over all stages: a stage run gets at most what is left of it (owner, Rev 14 addendum 2). */
export const TASK_BUDGET_USD = 6.0;

/** Tier name -> configured id; anything else is an explicit model id and passes through. */
export function specToId(spec: string, config: Pick<AgentConfig, "models">): string {
  return Object.hasOwn(config.models, spec) ? config.models[spec as ModelTier] : spec;
}

/** Effort of a run with `max` capped at `high` unless the owner confirmed (defense in depth; knobs and tier use it). */
export function safeEffort(route: Route): Effort | undefined {
  return route.effort === "max" && !route.ownerConfirmedMax ? "high" : route.effort;
}

/** Env override key of a stage: `dev_plan` for MODEL_DEV_PLAN / BUDGET_DEV_PLAN_USD. */
export const stageKey = (role: string, stage: string): string => `${role}_${stage}`.toLowerCase();

/**
 * Model id of a stage run. Anthropic path order: env pin (MODEL_<ROLE>_<STAGE>, or the legacy MODEL alias) >
 * forced tier > effort > the stage's `classTiers` > the stage's own `model`.
 * OpenRouter: tiers are not used; env pin (used as the model id) > the stage's `openrouterModel` > `config.model`.
 */
export function resolveModel(
  stage: StageDefinition,
  role: RoleDefinition | undefined,
  route: Route,
  config: AgentConfig,
): string {
  const pin = role && config.modelOverrides[stageKey(role.name, stage.name)];
  if (config.provider === "openrouter") return pin ?? stage.openrouterModel ?? config.model;
  if (pin) return specToId(pin, config);
  const cls = route.cls ?? "standard";
  // Opus from a forced tier needs the owner's confirmation; else it is capped at the high tier (class table).
  if (route.tier)
    return config.models[
      route.tier === "opus" && !route.ownerConfirmedMax ? effortTier("high", cls) : route.tier
    ];
  const effort = safeEffort(route);
  if (effort) return config.models[effortTier(effort, cls)];
  return specToId(stage.classTiers?.[cls] ?? stage.model, config);
}

/** True when a run's budget cap IS what the other stages left of the task ceiling (so a stage raise cannot help). */
export const ceilingBinds = (limitUsd: number | undefined, spentUsd = 0): boolean =>
  limitUsd !== undefined && spentUsd > 0 && Math.abs(limitUsd + spentUsd - TASK_BUDGET_USD) < 1e-6;

/**
 * Budget (USD) of a stage run, or undefined = no cap. Anthropic: env pin BUDGET_<ROLE>_<STAGE>_USD > the stage's
 * default (escalated answer re-runs use the larger one) plus any owner raise, limited to what is left of
 * TASK_BUDGET_USD, then capped by MAX_BUDGET_USD.
 * OpenRouter has no stage budget (SDK prices cost from Anthropic tables): only MAX_BUDGET_USD applies.
 */
export function resolveBudget(
  stage: StageDefinition,
  role: RoleDefinition | undefined,
  route: Route,
  config: AgentConfig,
): number | undefined {
  const cap = config.limits.maxBudgetUsd;
  if (config.provider === "openrouter") return cap;
  const pin = role && config.budgetOverrides[stageKey(role.name, stage.name)];
  const base =
    pin ?? (route.escalated ? (stage.escalatedBudgetUsd ?? stage.budgetUsd) : stage.budgetUsd);
  // Task ceiling: the stage gets at most what the task's other stages left of TASK_BUDGET_USD. An owner raise
  // (`go +usd`) widens the stage budget only, never the ceiling (a hard per-task cost cap by design).
  const left = Math.max(0, TASK_BUDGET_USD - (route.spentUsd ?? 0));
  const total = Math.min(base + (route.extraBudgetUsd ?? 0), left);
  return cap === undefined ? total : Math.min(total, cap);
}

/**
 * Auto-compact window (tokens) the orchestrator sets for a stage run, or undefined = leave the SDK default.
 * Env pin COMPACT_WINDOW_<ROLE>_<STAGE> (0 = off) > the stage's `autoCompactWindow`. Never read from the
 * owner's shell by the SDK child: only this value reaches it (see runtime/sdk-env.ts).
 */
export function resolveCompactWindow(
  stage: StageDefinition,
  role: RoleDefinition | undefined,
  config: AgentConfig,
): number | undefined {
  const pin = role && config.compactOverrides[stageKey(role.name, stage.name)];
  const tokens = pin ?? stage.autoCompactWindow;
  return tokens && tokens > 0 ? tokens : undefined;
}
