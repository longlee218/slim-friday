import { z } from "zod";

/** Placeholder value used in .env.example; never a real credential. */
export const PLACEHOLDER = "REPLACE_ME";

/** Default model: cheap Haiku for v1. Overridable via MODEL env. */
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/** Raw env schema. Discord vars are optional here; the bot entry enforces them via requireDiscord. */
const envSchema = z.object({
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
  AGENT_HOME: z.string().min(1),
  DEFAULT_REPO_PATH: z.string().min(1),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  DISCORD_TOKEN: z.string().min(1).optional(),
  OWNER_DISCORD_ID: z.string().min(1).optional(),
  MODEL: z.string().min(1).default(DEFAULT_MODEL),
  MAX_TURNS: z.coerce.number().int().positive().default(20),
  MAX_BUDGET_USD: z.coerce.number().positive().default(0.5),
  TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(3),
});

/** Validated, typed config used across the app. Contains secrets: never log it whole. */
export interface AgentConfig {
  /** OAuth token from `claude setup-token`; undefined when missing. Never log. */
  oauthToken: string | undefined;
  /** True only when the token exists and is not the REPLACE_ME placeholder. */
  hasRealAuthToken: boolean;
  discordToken: string | undefined;
  ownerDiscordId: string | undefined;
  agentHome: string;
  defaultRepoPath: string;
  logLevel: string;
  model: string;
  /** Run limits applied to every agent run. */
  limits: { maxTurns: number; maxBudgetUsd: number; timeoutMs: number };
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
  return {
    oauthToken: e.CLAUDE_CODE_OAUTH_TOKEN,
    hasRealAuthToken: !isPlaceholder(e.CLAUDE_CODE_OAUTH_TOKEN),
    discordToken: e.DISCORD_TOKEN,
    ownerDiscordId: e.OWNER_DISCORD_ID,
    agentHome: e.AGENT_HOME,
    defaultRepoPath: e.DEFAULT_REPO_PATH,
    logLevel: e.LOG_LEVEL,
    model: e.MODEL,
    limits: { maxTurns: e.MAX_TURNS, maxBudgetUsd: e.MAX_BUDGET_USD, timeoutMs: e.TIMEOUT_MS },
    maxConcurrentRuns: e.MAX_CONCURRENT_RUNS,
  };
}
