import { z } from "zod";

/** Placeholder value used in .env.example; never a real credential. */
export const PLACEHOLDER = "REPLACE_ME";

/** Default model on the Anthropic path: cheap Haiku for v1. Overridable via MODEL env. */
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/** Default model on the OpenRouter path. Overridable via MODEL env. */
export const DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-v4-flash";

/**
 * Default model for code tasks on OpenRouter. Plan mode needs a model that reliably calls
 * ExitPlanMode; deepseek-v4-flash does not (live test), a Claude model does.
 */
export const DEFAULT_OPENROUTER_CODE_MODEL = "anthropic/claude-haiku-4.5";

/** Default per-run budget (USD) on the Anthropic path; OpenRouter has none unless MAX_BUDGET_USD is set. */
const DEFAULT_ANTHROPIC_BUDGET_USD = 0.5;

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
  MODEL: z.string().trim().min(1).optional(),
  CODE_MODEL: z.string().trim().min(1).optional(),
  MAX_TURNS: z.coerce.number().int().positive().default(20),
  MAX_BUDGET_USD: z.coerce.number().positive().optional(),
  TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(3),
});

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
  agentHome: string;
  logLevel: string;
  model: string;
  /** Model for `task:` code tasks (plan mode + tools). Defaults to `model` on Anthropic. */
  codeModel: string;
  /**
   * Run limits applied to every agent run. maxBudgetUsd is undefined (no cap) on openrouter unless
   * MAX_BUDGET_USD is set: the SDK prices cost from Anthropic tables, wrong for other models.
   */
  limits: { maxTurns: number; maxBudgetUsd: number | undefined; timeoutMs: number };
  /** Global cap on simultaneous agent runs. */
  maxConcurrentRuns: number;
}

/** True when a value is missing or the placeholder. */
const isPlaceholder = (v: string | undefined): boolean => !v || v === PLACEHOLDER;

/**
 * Parse and validate env. Throws a readable error naming bad variables only (no values).
 * @param requireDiscord set true in 1b: DISCORD_TOKEN and OWNER_DISCORD_ID must be real.
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
  return {
    oauthToken: e.CLAUDE_CODE_OAUTH_TOKEN,
    openrouterApiKey: e.OPENROUTER_API_KEY,
    provider,
    ambiguousCredentials: hasRealOpenrouter && hasRealOauth && !e.LLM_PROVIDER,
    hasRealAuth: isOpenrouter ? hasRealOpenrouter : hasRealOauth,
    discordToken: e.DISCORD_TOKEN,
    ownerDiscordId: e.OWNER_DISCORD_ID,
    agentHome: e.AGENT_HOME,
    logLevel: e.LOG_LEVEL,
    model: e.MODEL ?? (isOpenrouter ? DEFAULT_OPENROUTER_MODEL : DEFAULT_MODEL),
    codeModel:
      e.CODE_MODEL ?? (isOpenrouter ? DEFAULT_OPENROUTER_CODE_MODEL : (e.MODEL ?? DEFAULT_MODEL)),
    limits: {
      maxTurns: e.MAX_TURNS,
      maxBudgetUsd: e.MAX_BUDGET_USD ?? (isOpenrouter ? undefined : DEFAULT_ANTHROPIC_BUDGET_USD),
      timeoutMs: e.TIMEOUT_MS,
    },
    maxConcurrentRuns: e.MAX_CONCURRENT_RUNS,
  };
}
