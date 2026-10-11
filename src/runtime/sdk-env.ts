import { type AgentConfig, pickEnv } from "../config/agent-config";

/** Env vars the SDK child may inherit. Everything else (GITHUB_TOKEN, AWS_*, ...) is withheld. */
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR", "CLAUDE_CONFIG_DIR"];

/** Compaction var the orchestrator sets per stage (never copied from the owner's shell). */
export const AUTO_COMPACT_WINDOW_VAR = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

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
 * Build the SDK child env from an allowlist plus the resolved provider's credentials only:
 * anthropic -> OAuth token (when real); openrouter -> base URL, auth token, empty API key, aliases.
 * `compactWindow` (the stage's, from `resolveCompactWindow`) is the ONLY source of the compaction var: it is not
 * in the allowlist, so a value in the caller env never passes through.
 */
export function sdkEnv(
  config: AgentConfig,
  source: Record<string, string | undefined> = process.env,
  compactWindow?: number,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = pickEnv(ENV_ALLOWLIST, source);
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
  if (compactWindow) env[AUTO_COMPACT_WINDOW_VAR] = String(compactWindow);
  return env;
}
