import type { Logger } from "pino";
import { z } from "zod";
import { DEFAULT_TIER_MODELS, type ModelTier } from "./model-routing";
import { type RoutingEnv, readRoutingEnv } from "./role-env";

/** Placeholder value used in .env.example; never a real credential. */
export const PLACEHOLDER = "REPLACE_ME";

/** Default `model` (Haiku tier). Roles resolve their own model (model-routing.ts); this one is the default model slot of the SDK env. */
const DEFAULT_MODEL = DEFAULT_TIER_MODELS.haiku;

/** Secret string: trimmed (no stray newline in auth headers); empty after trim counts as unset. */
const secret = z
  .string()
  .transform((v) => v.trim() || undefined)
  .optional();

/** Raw env schema. Discord vars are optional here; the bot entry enforces them via requireDiscord. */
const envSchema = z.object({
  CLAUDE_CODE_OAUTH_TOKEN: secret,
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
  MEMORY_MODEL: z.string().trim().min(1).optional(),
  GIT_AUTHOR: z.string().trim().min(1).optional(), // accepted and IGNORED since Rev 15 (the agent uses the owner's git config)
  MAX_BUDGET_USD: z.coerce.number().positive().optional(),
  TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
});

/** Names of the env variables the app itself reads: each must be classified in `data/child-env-deny.yaml`. */
export const ENV_SCHEMA_KEYS: string[] = Object.keys(envSchema.shape);

/** Validated, typed config used across the app. Contains secrets: never log it whole. */
/** `compactOverrides` (env COMPACT_WINDOW_<ROLE>) is declared with the other routing env in role-env.ts. */
export interface AgentConfig extends Pick<RoutingEnv, "compactOverrides"> {
  /** OAuth token from `claude setup-token`; undefined when missing. Never log. */
  oauthToken: string | undefined;
  /** True only when the OAuth token exists and is not the REPLACE_ME placeholder. */
  hasRealAuth: boolean;
  discordToken: string | undefined;
  ownerDiscordId: string | undefined;
  /** The one guild served (DISCORD_GUILD_ID); required once any workspace lists channels (see index.ts). */
  discordGuildId: string | undefined;
  agentHome: string;
  logLevel: string;
  /** Default model slot of the SDK env and the log value. Roles resolve via `models` (model-routing.ts). */
  model: string;
  /** Tier -> model id (env MODEL_HAIKU|SONNET|OPUS). */
  models: Record<ModelTier, string>;
  /** `<role>` -> tier or id (env MODEL_<ROLE>). */
  modelOverrides: Record<string, string>;
  /** `<role>` -> USD (env BUDGET_<ROLE>_USD). */
  budgetOverrides: Record<string, number>;
  /** Deprecated env vars that are set (logged once at startup as `config.deprecated`). */
  deprecated: string[];
  /** Model of the manual memory compaction call (one cheap call per over-threshold file). */
  memoryModel: string;
  /** Run limits of every agent run; maxBudgetUsd = optional global cap MAX_BUDGET_USD (min with the role budget). */
  limits: { maxBudgetUsd: number | undefined; timeoutMs: number };
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
  const routing = readRoutingEnv(env);
  return {
    ...routing,
    oauthToken: e.CLAUDE_CODE_OAUTH_TOKEN,
    hasRealAuth: !isPlaceholder(e.CLAUDE_CODE_OAUTH_TOKEN),
    discordToken: e.DISCORD_TOKEN,
    ownerDiscordId: e.OWNER_DISCORD_ID,
    discordGuildId: e.DISCORD_GUILD_ID,
    agentHome: e.AGENT_HOME,
    logLevel: e.LOG_LEVEL,
    model: DEFAULT_MODEL,
    memoryModel: e.MEMORY_MODEL ?? routing.models.haiku,
    limits: {
      maxBudgetUsd: e.MAX_BUDGET_USD,
      timeoutMs: e.TIMEOUT_MS,
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

/** Warn once at startup about deprecated env vars (MODEL, the old two-part shapes). Names only. */
export function logDeprecatedConfig(log: Logger, config: AgentConfig): void {
  if (!config.deprecated.length) return;
  log.warn(
    { event: "config.deprecated", vars: config.deprecated },
    "deprecated env vars: MODEL is no longer used (use MODEL_<ROLE> / MODEL_<TIER>); the old names with a second part (MODEL_<ROLE>_<X>, BUDGET_<ROLE>_<X>_USD, COMPACT_WINDOW_<ROLE>_<X>) are ignored, use MODEL_<ROLE>, BUDGET_<ROLE>_USD, COMPACT_WINDOW_<ROLE>",
  );
}
