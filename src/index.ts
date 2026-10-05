import { type AgentConfig, loadConfig } from "./config/agent-config";
import { logProviderSelected } from "./config/log-provider";
import { createDiscordBot } from "./ingress/discord-bot";
import { createShutdown } from "./lifecycle/shutdown";
import { logger } from "./observability/logger";
import { redactText } from "./observability/redact";
import { openDb } from "./storage/db";
import { createTaskHandler } from "./tasks/handle-task";
import { createRunLimiter } from "./tasks/run-limiter";
import { workspacePaths } from "./workspace/workspace-paths";

const log = logger.child({ module: "index" });

/** Log a fatal startup error (names only, never values) and exit. */
function fail(message: string): never {
  log.error(message);
  process.exit(1);
}

/** Boot: config, db, Discord login, graceful shutdown. */
async function main(): Promise<void> {
  let config: AgentConfig;
  try {
    // Fail fast before any connection when DISCORD_TOKEN / OWNER_DISCORD_ID are missing or placeholders.
    config = loadConfig(process.env, { requireDiscord: true });
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err));
  }

  // Fail fast: the resolved provider has no real credential (name only, never a key).
  if (!config.hasRealAuth) return fail(`No credential for provider ${config.provider}`);

  // Provider and model only; never keys.
  logProviderSelected(log, config);

  const db = openDb(workspacePaths(config.agentHome).dbFile);
  const handleTask = createTaskHandler({
    db,
    config,
    limiter: createRunLimiter(config.maxConcurrentRuns),
  });
  const { client } = createDiscordBot(config, handleTask);

  /** Graceful shutdown: abort + await runs, drop the connection, close db (Phase 5 hardens). */
  const shutdown = createShutdown({
    drain: handleTask.drain,
    destroyClient: () => client.destroy(),
    closeDb: () => db.close(),
    log: (m) => log.info(m),
    exit: (c) => process.exit(c),
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  // Stray errors: log (redacted) and shut down cleanly instead of dying mid-write.
  process.on("unhandledRejection", (e) => {
    log.error({ err: redactText(String(e)) }, "unhandled rejection");
    void shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (e) => {
    log.error({ err: redactText(String(e)) }, "uncaught exception");
    void shutdown("uncaughtException", 1);
  });

  try {
    await client.login(config.discordToken);
  } catch (err) {
    log.error(
      { err: redactText(String(err)).replaceAll(config.discordToken!, "[REDACTED]") },
      "discord login failed",
    );
    db.close();
    process.exit(1);
  }
}

void main();
