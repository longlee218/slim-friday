import { type AgentConfig, pickEnv } from "../config/agent-config";

/** Env vars the SDK child may inherit. Everything else (GITHUB_TOKEN, AWS_*, ...) is withheld. */
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR", "CLAUDE_CONFIG_DIR"];

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
 */
export function sdkEnv(
  config: AgentConfig,
  source: Record<string, string | undefined> = process.env,
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
  return env;
}
