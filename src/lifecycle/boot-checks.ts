import { type AgentConfig, loadConfig } from "../config/agent-config";
import { readProcessEnv } from "../config/process-env";
import { ensureHome } from "../memory/persona";
import { homePlacementError } from "./home-placement-check";
import { registryError } from "./registry-check";

/** What a valid boot hands to the composition root. */
export interface BootState {
  config: AgentConfig;
}

/**
 * Fail-fast startup checks: config, credential, role registry, home placement. Throws with a message of names only (never values); creates the missing persona/memory files.
 */
export function loadBootState(): BootState {
  const config = loadConfig(readProcessEnv(), { requireDiscord: false });
  if (!config.hasRealAuth) throw new Error("CLAUDE_CODE_OAUTH_TOKEN missing or placeholder");
  const badRole = registryError();
  if (badRole) throw new Error(`Invalid role registry: ${badRole}`);

  // The home (persona, memory, db, logs) must not live inside a git working tree.
  const misplaced = homePlacementError(config.agentHome, []);
  if (misplaced) throw new Error(misplaced);

  // Create the missing root persona/memory files once, never overwriting.
  ensureHome(config.agentHome, []);
  return { config };
}
