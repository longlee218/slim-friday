import { type Client, Events } from "discord.js";
import { createDiscordApprovalGateway } from "./approvals/discord-approval";
import { type AgentConfig, loadConfig, logProviderSelected } from "./config/agent-config";
import { workspacePaths } from "./config/workspace-paths";
import { createDiscordBot } from "./ingress/discord-bot";
import { createResumeHandler, postResumeNotices } from "./lifecycle/resume-interrupted";
import { createShutdown } from "./lifecycle/shutdown";
import { runStartupHygiene } from "./lifecycle/startup";
import { logEvent, logger } from "./observability/logger";
import { errText } from "./observability/redact";
import { openDb } from "./storage/db";
import { interruptRunningTasks } from "./storage/run-store";
import { createTaskHandler } from "./tasks/handle-task";
import { createRunLimiter } from "./tasks/run-limiter";

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
  // A crash leaves tasks "running"/"waiting_approval": they stop counting against the code-task cap and
  // become "interrupted"; after Discord is ready each such thread gets a Resume button.
  interruptRunningTasks(db);
  runStartupHygiene(db, config.agentHome);
  // Client is created after the handler, so the gateway looks it up lazily.
  let botClient: Client | undefined;
  const approvals = createDiscordApprovalGateway({
    getClient: () => botClient,
    ownerId: config.ownerDiscordId!,
    db,
  });
  const handleTask = createTaskHandler({
    db,
    config,
    approvals,
    limiter: createRunLimiter(config.maxConcurrentRuns),
  });
  const handleResume = createResumeHandler({
    db,
    getClient: () => botClient,
    ownerId: config.ownerDiscordId!,
    handleTask,
  });
  // One interaction listener: each handler ignores buttons of the other (different customId prefix).
  const { client } = createDiscordBot(config, handleTask, async (i) => {
    await approvals.handleInteraction(i);
    await handleResume(i);
  });
  botClient = client;
  client.once(Events.ClientReady, () => {
    void postResumeNotices({ db, getClient: () => botClient });
  });

  /** Graceful shutdown: abort + await runs, drop the connection, close db. */
  const shutdown = createShutdown({
    drain: handleTask.drain,
    destroyClient: async () => {
      await handleTask.close().catch(() => undefined); // stop the git MCP server process
      await client.destroy();
    },
    closeDb: () => db.close(),
    log: (m) => logEvent(log, "app.shutdown", { reason: m }),
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
    log.error({ err: errText(e) }, "unhandled rejection");
    void shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (e) => {
    log.error({ err: errText(e) }, "uncaught exception");
    void shutdown("uncaughtException", 1);
  });

  try {
    await client.login(config.discordToken);
  } catch (err) {
    log.error(
      { err: errText(err).replaceAll(config.discordToken!, "[REDACTED]") },
      "discord login failed",
    );
    db.close();
    process.exit(1);
  }
  logEvent(log, "app.started", {
    provider: config.provider,
    model: config.model,
    codeModel: config.codeModel,
    agentHome: config.agentHome,
    pid: process.pid,
  });
}

void main();
