import type { Logger } from "pino";
import { z } from "zod";
import { DEFAULT_TIER_MODELS, type ModelTier, specToId } from "./model-routing";
import { readRoutingEnv } from "./stage-env";

/** Placeholder value used in .env.example; never a real credential. */
export const PLACEHOLDER = "REPLACE_ME";

/** Default `model` on the Anthropic path (Haiku tier). Stages resolve their own model (model-routing.ts); this one is the legacy MODEL slot. */
const DEFAULT_MODEL = DEFAULT_TIER_MODELS.haiku;

/** Default model on the OpenRouter path. Overridable via MODEL env. */
const DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-v4-flash";

/**
 * Default model for owner-triggered memory compaction: tier haiku on Anthropic (MODEL_HAIKU applies), a Haiku
 * id on OpenRouter. Never MODEL.
 */
const DEFAULT_OPENROUTER_MEMORY_MODEL = "anthropic/claude-haiku-4.5";

/** LLM backend the SDK child talks to. */
export type LlmProvider = "anthropic" | "openrouter";

/** Secret string: trimmed (no stray newline in auth headers); empty after trim counts as unset. */
const secret = z
  .string()
  .transform((v) => v.trim() || undefined)
  .optional();

/** Raw env schema. Discord vars are optional here; the bot entry enforces them via requireDiscord. */
const envSchema = z.object({
  CLAUDE_CODE_OAUTH_TOKEN: secret,
  OPENROUTER_API_KEY: secret,
  LLM_PROVIDER: z.enum(["anthropic", "openrouter"]).optional(),
  AGENT_HOME: z.string().min(1),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  DISCORD_TOKEN: secret,
  OWNER_DISCORD_ID: z.string().min(1).optional(),
  /** Guild snowflake; empty or the placeholder counts as unset, anything else must be 17-20 digits. */
  DISCORD_GUILD_ID: z
    .string()
    .trim()
    .transform((v) => (v === "" || v === PLACEHOLDER ? undefined : v))
    .pipe(
      z
        .string()
        .regex(/^\d{17,20}$/)
        .optional(),
    )
    .optional(),
  // Legacy alias, KEPT on purpose (the owner's .env still sets it): pins assistant qa, warns once at startup (stage-env.ts).
  MODEL: z.string().trim().min(1).optional(),
  MEMORY_MODEL: z.string().trim().min(1).optional(),
  GIT_AUTHOR: z.string().trim().min(1).optional(),
  MAX_TURNS: z.coerce.number().int().positive().default(20),
  MAX_BUDGET_USD: z.coerce.number().positive().optional(),
  TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(3),
  // Intent layer L3 (src/intent). `jev` is the owner's later engine: accepted here, refused by the factory until it exists.
  INTENT_ENGINE: z.enum(["haiku", "jev", "none"]).default("haiku"),
  MODEL_INTENT: z.string().trim().min(1).optional(),
  INTENT_BUDGET_USD: z.coerce.number().positive().default(0.02),
  INTENT_TIMEOUT_MS: z.coerce.number().int().min(8000).default(8000),
  CLONE_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
});

/** Engines of the intent layer's L3 classifier (`none` = rules L0-L2 only). */
export type IntentEngine = "haiku" | "jev" | "none";

/** Validated, typed config used across the app. Contains secrets: never log it whole. */
export interface AgentConfig {
  /** OAuth token from `claude setup-token`; undefined when missing. Never log. */
  oauthToken: string | undefined;
  /** OpenRouter API key; undefined when missing. Never log. */
  openrouterApiKey: string | undefined;
  /** Resolved backend: OPENROUTER_API_KEY real -> openrouter, else anthropic; LLM_PROVIDER forces. */
  provider: LlmProvider;
  /** True when both credentials are real and LLM_PROVIDER is unset (openrouter wins silently). */
  ambiguousCredentials: boolean;
  /** True only when the resolved provider's credential exists and is not the REPLACE_ME placeholder. */
  hasRealAuth: boolean;
  discordToken: string | undefined;
  ownerDiscordId: string | undefined;
  /** The one guild served (DISCORD_GUILD_ID); required once any workspace lists channels (see index.ts). */
  discordGuildId: string | undefined;
  agentHome: string;
  logLevel: string;
  /** OpenRouter default model (every stage without its own pin / `openrouterModel`) and the log value. Anthropic stages resolve via `models` (model-routing.ts). */
  model: string;
  /** Tier -> model id (env MODEL_HAIKU|SONNET|OPUS). */
  models: Record<ModelTier, string>;
  /** `<role>_<stage>` -> tier or id (env MODEL_<ROLE>_<STAGE>, plus the legacy MODEL alias). */
  modelOverrides: Record<string, string>;
  /** `<role>_<stage>` -> USD (env BUDGET_<ROLE>_<STAGE>_USD). */
  budgetOverrides: Record<string, number>;
  /** Deprecated env vars that are set (logged once at startup as `config.deprecated`). */
  deprecated: string[];
  /** Model of the manual memory compaction call (one cheap call per over-threshold file). */
  memoryModel: string;
  /** Default commit identity `Name <email>` for repos without their own `gitAuthor`. */
  gitAuthor: string | undefined;
  /** Run limits of every agent run; maxBudgetUsd = optional global cap MAX_BUDGET_USD (min with the stage budget; OpenRouter: only this). */
  limits: { maxTurns: number; maxBudgetUsd: number | undefined; timeoutMs: number };
  /** Global cap on simultaneous agent runs. */
  maxConcurrentRuns: number;
  /** Days a delivered/kept task clone is retained before startup removes it (CLONE_RETENTION_DAYS). */
  cloneRetentionDays: number;
  /** Intent layer L3: engine, model id (MODEL_INTENT, tier-resolvable), per-call budget and timeout. */
  intent: { engine: IntentEngine; model: string; budgetUsd: number; timeoutMs: number };
}

/** True when a value is missing or the placeholder. */
const isPlaceholder = (v: string | undefined): boolean => !v || v === PLACEHOLDER;

/**
 * Parse and validate env. Throws a readable error naming bad variables only (no values).
 * @param requireDiscord set true for the bot entry: DISCORD_TOKEN and OWNER_DISCORD_ID must be real.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  opts: { requireDiscord?: boolean } = {},
): AgentConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment variables: ${names}`);
  }
  const e = parsed.data;
  if (
    opts.requireDiscord &&
    (isPlaceholder(e.DISCORD_TOKEN) || isPlaceholder(e.OWNER_DISCORD_ID))
  ) {
    throw new Error("Invalid environment variables: DISCORD_TOKEN, OWNER_DISCORD_ID required");
  }
  const hasRealOpenrouter = !isPlaceholder(e.OPENROUTER_API_KEY);
  const hasRealOauth = !isPlaceholder(e.CLAUDE_CODE_OAUTH_TOKEN);
  const provider: LlmProvider = e.LLM_PROVIDER ?? (hasRealOpenrouter ? "openrouter" : "anthropic");
  const isOpenrouter = provider === "openrouter";
  const routing = readRoutingEnv(env);
  return {
    ...routing,
    oauthToken: e.CLAUDE_CODE_OAUTH_TOKEN,
    openrouterApiKey: e.OPENROUTER_API_KEY,
    provider,
    ambiguousCredentials: hasRealOpenrouter && hasRealOauth && !e.LLM_PROVIDER,
    hasRealAuth: isOpenrouter ? hasRealOpenrouter : hasRealOauth,
    discordToken: e.DISCORD_TOKEN,
    ownerDiscordId: e.OWNER_DISCORD_ID,
    discordGuildId: e.DISCORD_GUILD_ID,
    agentHome: e.AGENT_HOME,
    logLevel: e.LOG_LEVEL,
    model: e.MODEL ?? (isOpenrouter ? DEFAULT_OPENROUTER_MODEL : DEFAULT_MODEL),
    gitAuthor: e.GIT_AUTHOR,
    memoryModel:
      e.MEMORY_MODEL ?? (isOpenrouter ? DEFAULT_OPENROUTER_MEMORY_MODEL : routing.models.haiku),
    limits: {
      maxTurns: e.MAX_TURNS,
      maxBudgetUsd: e.MAX_BUDGET_USD,
      timeoutMs: e.TIMEOUT_MS,
    },
    maxConcurrentRuns: e.MAX_CONCURRENT_RUNS,
    cloneRetentionDays: e.CLONE_RETENTION_DAYS,
    intent: {
      engine: e.INTENT_ENGINE,
      // A tier name (haiku|sonnet|opus) resolves to its id on Anthropic; OpenRouter takes the id as is.
      model: isOpenrouter
        ? (e.MODEL_INTENT ?? DEFAULT_OPENROUTER_MEMORY_MODEL)
        : specToId(e.MODEL_INTENT ?? "haiku", routing),
      budgetUsd: e.INTENT_BUDGET_USD,
      timeoutMs: e.INTENT_TIMEOUT_MS,
    },
  };
}

/** Copy the listed vars that are set (non-empty) from `source`: the one env allowlist helper. */
export function pickEnv(
  keys: readonly string[],
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of keys) if (source[k]) env[k] = source[k]!;
  return env;
}

/** Log one startup line naming the provider and model, plus a warning when the choice is implicit. Never includes credentials. */
export function logProviderSelected(log: Logger, config: AgentConfig): void {
  log.info({ provider: config.provider, model: config.model }, "llm provider selected");
  if (config.ambiguousCredentials)
    log.warn("both credentials set; using openrouter (set LLM_PROVIDER=anthropic to change)");
}

/** Warn once at startup about env vars kept only as aliases (MODEL). Names only. */
export function logDeprecatedConfig(log: Logger, config: AgentConfig): void {
  if (!config.deprecated.length) return;
  log.warn(
    { event: "config.deprecated", vars: config.deprecated },
    "deprecated env vars (use MODEL_ASSISTANT_QA, MODEL_DEV_PLAN, MODEL_DEV_EXEC or the MODEL_<TIER> ids)",
  );
}
