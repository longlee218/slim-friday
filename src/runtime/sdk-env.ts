import type { AgentConfig } from "../config/agent-config";
import { isChildEnvDenied, isWorkerEnvDenied } from "../config/child-env-deny";

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

/** Claude Code switch: strip Anthropic and cloud provider credentials from the env of the tools' subprocesses (workers only). */
export const SUBPROCESS_SCRUB_VAR = "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB";

/**
 * Build the SDK child env: the owner's env passes through (the agent runs as the owner, with the owner's git / gh / ssh
 * auth) minus the bot's own variables (`config/data/child-env-deny.yaml`), then the app-owned ones on top: the OAuth token (when real), the subagent limits, the compaction vars (window = `compactWindow` from `resolveCompactWindow`, else the app default;
 * 0 = no window var; percent always) and the cache TTL vars: the ONLY source of these, the same names in the
 * caller env are on the deny list. `opts.worker` (a dispatched worker) drops every secret-like variable too and turns the SDK's
 * subprocess scrub on.
 */
export function sdkEnv(
  config: AgentConfig,
  source: Record<string, string | undefined> = process.env,
  compactWindow?: number,
  opts: { oneShot?: boolean; worker?: boolean } = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  // A dispatched worker (it runs repo code in its shell) also loses every token, key, secret, cloud and git auth of the owner.
  const denied = opts.worker ? isWorkerEnvDenied : isChildEnvDenied;
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && !denied(name)) env[name] = value;
  if (config.hasRealAuth) env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;
  Object.assign(env, SUBAGENT_LIMIT_ENV);
  // The SDK strips the credentials above from the env of its Bash tool, hooks and MCP servers: the model call still has them.
  if (opts.worker) env[SUBPROCESS_SCRUB_VAR] = "1";
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
