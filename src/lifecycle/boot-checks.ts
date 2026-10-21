import { homedir } from "node:os";
import type { Logger } from "pino";
import { type AgentConfig, loadConfig } from "../config/agent-config";
import { readProcessEnv } from "../config/process-env";
import { opsIds, readDiscordSetup } from "../discord-setup/discord-setup-config";
import { warnOpsChannelsInWorkspaces } from "../discord-setup/warn-ops-channels";
import { real } from "../locations/location-registry";
import { safely } from "../memory/index/safely";
import { migrateMemoryLayers } from "../memory/memory-layer-migration";
import { ensureHome } from "../memory/persona";
import { loadWorkspaces, warnOverlap } from "../workspaces/workspace-registry";
import { homePlacementError } from "./home-placement-check";
import { registryError } from "./registry-check";

/** What a valid boot hands to the composition root. */
export interface BootState {
  config: AgentConfig;
  workspaces: ReturnType<typeof loadWorkspaces>["workspaces"];
  setup: ReturnType<typeof readDiscordSetup>;
}

/**
 * Fail-fast startup checks before any connection: config, credential, role registry, home placement, guild pin,
 * discord.yaml. Throws with a message of names only (never values); creates the missing persona/memory files.
 */
export function loadBootState(log: Logger): BootState {
  const config = loadConfig(readProcessEnv(), { requireDiscord: true });
  if (!config.hasRealAuth) throw new Error("CLAUDE_CODE_OAUTH_TOKEN missing or placeholder");
  const badRole = registryError();
  if (badRole) throw new Error(`Invalid role registry: ${badRole}`);

  const { workspaces } = loadWorkspaces(config.agentHome);
  warnOverlap(workspaces); // once per start: later scans stay quiet

  // The home (persona, memory, db, logs) must not live inside a location or a git working tree.
  // A location equal to the owner's $HOME is allowed: the guard denies AGENT_HOME to every run instead.
  const userHomes = [homedir(), readProcessEnv().HOME ?? ""].filter(Boolean).map(real);
  const misplaced = homePlacementError(
    config.agentHome,
    workspaces.flatMap((w) =>
      w.locations.map((r) => r.path).filter((p) => !userHomes.includes(real(p))),
    ),
  );
  if (misplaced) throw new Error(misplaced);

  // Create the missing root persona/memory files once, never overwriting; works with zero workspaces.
  ensureHome(config.agentHome, workspaces);
  // One-time merge of the retired workspace/location memory into the channel files; never blocks the start.
  safely("memory layers migration", () => migrateMemoryLayers(config.agentHome, workspaces));

  // Once a workspace lists channels, ingress must be pinned to one guild.
  if (!config.discordGuildId && workspaces.some((w) => w.channels.length))
    throw new Error("DISCORD_GUILD_ID required: a workspace lists channels");

  // An unparsable discord.yaml could hide the ops/control channels, so refuse to start.
  const setup = readDiscordSetup(config.agentHome);
  warnOpsChannelsInWorkspaces(workspaces, opsIds(setup), log);
  return { config, workspaces, setup };
}
