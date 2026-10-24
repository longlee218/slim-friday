import { join } from "node:path";
import { TEMPLATES_DIR } from "@friday/config";
import { ClaudeRuntime } from "@friday/runtime-claude";
import { connectDiscord } from "@friday/surface-discord";
import type { AgentConfig } from "../../../src/config/agent-config";
import { readProcessEnv } from "../../../src/config/process-env";
import { logEvent, logger } from "../../../src/observability/logger";
import { fridayExtraDirs } from "./friday-bot";
import { startApp } from "./start-app";

const log = logger.child({ module: "engine" });

/** A required value: missing and the `REPLACE_ME` placeholder both count as absent. */
function need(name: string, value: string | undefined): string {
  if (!value || value === "REPLACE_ME") throw new Error(`${name} missing`);
  return value;
}

/**
 * Run the bot engine on Discord until `signal` aborts: connect, build the Claude runtime, start the app.
 * Refuses by variable name, before any network call, when a Discord value is missing.
 * `connect` is injectable for tests.
 */
export async function startEngine(
  opts: { config: AgentConfig; agentHome: string; signal: AbortSignal },
  connect: typeof connectDiscord = connectDiscord,
): Promise<void> {
  const { config, agentHome, signal } = opts;
  const token = need("DISCORD_TOKEN", config.discordToken);
  const guildId = need("DISCORD_GUILD_ID", config.discordGuildId);
  const ownerId = need("OWNER_DISCORD_ID", config.ownerDiscordId);

  const configDir = join(agentHome, "config");
  const port = await connect({ token, guildId, ownerId });
  try {
    const runtime = new ClaudeRuntime({
      oauthToken: config.oauthToken,
      agentHome,
      scratchRoot: join(agentHome, "scratch"),
      env: readProcessEnv(),
      extraDirsFor: fridayExtraDirs(configDir, TEMPLATES_DIR),
    });
    const app = await startApp({ port, runtime, agentHome, log });
    logEvent(log, "engine.started", { agentHome });
    if (!signal.aborted)
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    await app.stop();
  } finally {
    await port.close();
  }
}
