import { mkdirSync } from "node:fs";
import { type AgentConfig, loadConfig } from "../config/agent-config";
import { readProcessEnv } from "../config/process-env";
import { homePlacementError } from "./home-placement-check";
import { checkTools, type ToolWarning } from "./tool-check";

/** What a valid boot hands to the composition root. */
export interface BootState {
  config: AgentConfig;
  /** Tools the file skills need that are not installed (empty when all are). */
  toolWarnings: ToolWarning[];
}

/**
 * Fail-fast startup checks: config, credential, home placement. Throws with a message of names only (never
 * values); creates AGENT_HOME when it is missing. `env` is the process env unless a test passes its own.
 */
export function loadBootState(
  env: Record<string, string | undefined> = readProcessEnv(),
  which?: (name: string) => string | null,
): BootState {
  const config = loadConfig(env);
  if (!config.hasRealAuth) throw new Error("CLAUDE_CODE_OAUTH_TOKEN missing or placeholder");

  // The home (memory, config, db, logs) must not live inside a git working tree.
  const misplaced = homePlacementError(config.agentHome, []);
  if (misplaced) throw new Error(misplaced);
  mkdirSync(config.agentHome, { recursive: true, mode: 0o700 });
  // Missing tools only warn: the engine works without them.
  return { config, toolWarnings: checkTools(which) };
}
