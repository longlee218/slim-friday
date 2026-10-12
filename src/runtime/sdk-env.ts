import type { AgentConfig } from "../config/agent-config";
import { isChildEnvDenied } from "../config/child-env-deny";

/** Compaction window var the orchestrator sets (on the deny list: never copied from the owner's shell, like the 3 below). */
export const AUTO_COMPACT_WINDOW_VAR = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/** Percent-of-window var: compaction fires at this share of the window; it can only LOWER the SDK default, main + subagents. */
export const AUTOCOMPACT_PCT_VAR = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
/** Prompt-cache TTL of the main loop (SDK turns included) and of subagents. Both accept `5m` or `1h`. */
export const PROMPT_CACHE_TTL_VAR = "CLAUDE_CODE_PROMPT_CACHE_TTL";
export const SUBAGENT_CACHE_TTL_VAR = "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL";

type CacheTtl = "5m" | "1h";

/**
 * App default compaction window for EVERY role (owner: 75% for all roles and subagents). The SDK caps it at the
 * model's own window (Haiku 200k -> fires near 150k), so one constant serves all models. Range 100000-1000000.
 */
export const COMPACT_WINDOW_TOKENS = 1_000_000;
/** Share (percent) of the window at which the SDK compacts mid-run. */
export const COMPACT_PCT = 75;
/** Main-loop cache TTL (owner: 1h); undefined = leave the SDK default. */
export const MAIN_CACHE_TTL: CacheTtl | undefined = "1h";
/** Subagent cache TTL (owner: 1h). */
export const SUBAGENT_CACHE_TTL: CacheTtl = "1h";

/**
 * Subagent limits the app always sets (never copied from the owner's shell; both PASS in the P3.0 spike, Q3/Q5):
 * foreground subagents only (the Agent tool otherwise defaults to background), and depth 1 (a subagent gets no Agent tool).
 */
const SUBAGENT_LIMIT_ENV = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
} as const;

/** OpenRouter's Anthropic-compatible endpoint. */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/**
 * Model alias variables (Claude Code model-config docs + OpenRouter claude-code guide).
 * All point at the configured model so helper/subagent calls never hit a Claude model id.
 */
const MODEL_ALIAS_VARS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

/**
 * Build the SDK child env: the owner's env passes through (the agent runs as the owner, with the owner's git / gh / ssh
 * auth) minus the bot's own variables (`config/data/child-env-deny.yaml`), then the app-owned ones on top: the resolved
 * provider's credentials (anthropic -> OAuth token when real; openrouter -> base URL, auth token, empty API key,
 * aliases), the subagent limits, the compaction vars (window = `compactWindow` from `resolveCompactWindow`, else the app default;
 * 0 = no window var; percent always) and the cache TTL vars: the ONLY source of these, the same names in the
 * caller env are on the deny list.
 */
export function sdkEnv(
  config: AgentConfig,
  source: Record<string, string | undefined> = process.env,
  compactWindow?: number,
  opts: { oneShot?: boolean } = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && !isChildEnvDenied(name)) env[name] = value;
  if (config.provider === "openrouter") {
    env.ANTHROPIC_BASE_URL = OPENROUTER_BASE_URL;
    if (config.hasRealAuth) env.ANTHROPIC_AUTH_TOKEN = config.openrouterApiKey;
    // Must be present and empty, or Claude Code prefers it over the auth token.
    env.ANTHROPIC_API_KEY = "";
    for (const k of MODEL_ALIAS_VARS) env[k] = config.model;
  } else if (config.hasRealAuth) {
    env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;
  }
  Object.assign(env, SUBAGENT_LIMIT_ENV);
  // One-shot calls (intent classifier, memory compaction) are single-turn: no compaction, and a 1h cache write
  // would only cost more than it saves, so they get none of the four vars.
  if (opts.oneShot) return env;
  const window = compactWindow ?? COMPACT_WINDOW_TOKENS;
  if (window > 0) env[AUTO_COMPACT_WINDOW_VAR] = String(window);
  env[AUTOCOMPACT_PCT_VAR] = String(COMPACT_PCT);
  if (MAIN_CACHE_TTL) env[PROMPT_CACHE_TTL_VAR] = MAIN_CACHE_TTL;
  env[SUBAGENT_CACHE_TTL_VAR] = SUBAGENT_CACHE_TTL;
  return env;
}
