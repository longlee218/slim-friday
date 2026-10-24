import { z } from "zod";

/** Placeholder value used in .env.example; never a real credential. */
export const PLACEHOLDER = "REPLACE_ME";

/** Secret string: trimmed (no stray newline in auth headers); empty after trim counts as unset. */
const secret = z
  .string()
  .transform((v) => v.trim() || undefined)
  .optional();

/** Raw env schema. Discord vars are optional here; the bot entry enforces them (`startEngine`). */
const envSchema = z.object({
  CLAUDE_CODE_OAUTH_TOKEN: secret,
  AGENT_HOME: z.string().min(1),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  DISCORD_TOKEN: secret,
  /** Optional Axiom log shipping (metadata only); both must be set. Read by the logger bootstrap. */
  AXIOM_TOKEN: secret,
  AXIOM_DATASET: z.string().min(1).optional(),
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
});

/** Names of the env variables the app itself reads: each must be classified in the runtime's child-env deny list. */
export const ENV_SCHEMA_KEYS: string[] = Object.keys(envSchema.shape);

/** Validated, typed config used across the app. Contains secrets: never log it whole. */
export interface AgentConfig {
  /** OAuth token from `claude setup-token`; undefined when missing. Never log. */
  oauthToken: string | undefined;
  /** True only when the OAuth token exists and is not the REPLACE_ME placeholder. */
  hasRealAuth: boolean;
  discordToken: string | undefined;
  ownerDiscordId: string | undefined;
  /** The one guild served (DISCORD_GUILD_ID). */
  discordGuildId: string | undefined;
  agentHome: string;
  logLevel: string;
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
  return {
    oauthToken: e.CLAUDE_CODE_OAUTH_TOKEN,
    hasRealAuth: !isPlaceholder(e.CLAUDE_CODE_OAUTH_TOKEN),
    discordToken: e.DISCORD_TOKEN,
    ownerDiscordId: e.OWNER_DISCORD_ID,
    discordGuildId: e.DISCORD_GUILD_ID,
    agentHome: e.AGENT_HOME,
    logLevel: e.LOG_LEVEL,
  };
}
