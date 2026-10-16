import type { Logger } from "pino";
import { z } from "zod";
import { HAIKU_MODEL } from "./model-ids";
import { type RoutingEnv, readRoutingEnv } from "./role-env";

/** Placeholder value used in .env.example; never a real credential. */
export const PLACEHOLDER = "REPLACE_ME";

/** Default `model` (Haiku). Each role names its own model (`RoleDefinition.model`); this one is the default model slot of the SDK env. */
const DEFAULT_MODEL = HAIKU_MODEL;

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
  /** Default model slot of the SDK env and the log value. Roles name their own model. */
  model: string;
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
    memoryModel: e.MEMORY_MODEL ?? HAIKU_MODEL,
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

/** Warn once at startup about deprecated env vars (MODEL, MODEL_<X>, the old two-part shapes). Names only. */
export function logDeprecatedConfig(log: Logger, config: AgentConfig): void {
  if (!config.deprecated.length) return;
  log.warn(
    { event: "config.deprecated", vars: config.deprecated },
    "deprecated env vars are ignored: MODEL and MODEL_<X> (each role has a fixed model); the old names with a second part (BUDGET_<ROLE>_<X>_USD, COMPACT_WINDOW_<ROLE>_<X>) too, use BUDGET_<ROLE>_USD, COMPACT_WINDOW_<ROLE>",
  );
}
