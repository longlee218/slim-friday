import { type Client, Events } from "discord.js";
import pkg from "../package.json";
import { createDiscordApprovalGateway } from "./approvals/discord-approval";
import {
  type AgentConfig,
  loadConfig,
  logDeprecatedConfig,
  logProviderSelected,
} from "./config/agent-config";
import { workspacePaths } from "./config/workspace-paths";
import { opsIds, readDiscordSetup } from "./discord-setup/discord-setup-config";
import { createOpsLog } from "./discord-setup/ops-log";
import { warnIfBotAdministrator } from "./discord-setup/ready-checks";
import { warnOpsChannelsInWorkspaces } from "./discord-setup/warn-ops-channels";
import { createDiscordBot } from "./ingress/discord-bot";
import { buildIntentDeps } from "./intent/intent-deps";
import { homePlacementError } from "./lifecycle/home-placement-check";
import {
  expireStaleProposals,
  postProposalNotices,
  releaseQueuedProposals,
} from "./lifecycle/proposal-notices";
import { createResumeHandler, postResumeNotices } from "./lifecycle/resume-interrupted";
import { createShutdown } from "./lifecycle/shutdown";
import { runStartupHygiene } from "./lifecycle/startup";
import { ensureHome } from "./memory/persona";
import { logEvent, logger } from "./observability/logger";
import { errText } from "./observability/redact";
import { createTurnHandler } from "./orchestrator/handle-message";
import { createRunLimiter } from "./orchestrator/turns/run-limiter";
import { openDb } from "./storage/db";
import { interruptRunningTurns } from "./storage/run-store";
import { loadWorkspaces } from "./workspaces/workspace-registry";

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

  const { workspaces } = loadWorkspaces(config.agentHome);

  // Fail closed: the home (persona, memory, db, logs) must not live inside a repo or a git working tree.
  const misplaced = homePlacementError(
    config.agentHome,
    workspaces.flatMap((w) => w.repos.map((r) => r.path)),
  );
  if (misplaced) return fail(misplaced);

  // Create the missing root persona/memory files (and per-workspace/repo memory) once at startup, never
  // overwriting; works with zero workspaces, so a fresh home is complete before the first message.
  ensureHome(config.agentHome, workspaces);

  // Fail closed: once a workspace lists channels, ingress must be pinned to one guild.
  if (!config.discordGuildId && workspaces.some((w) => w.channels.length))
    return fail("DISCORD_GUILD_ID required: a workspace lists channels");

  // Fail closed: an unparsable discord.yaml could hide the ops/control channels, so refuse to start.
  let setup: ReturnType<typeof readDiscordSetup>;
  try {
    setup = readDiscordSetup(config.agentHome);
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err));
  }
  warnOpsChannelsInWorkspaces(workspaces, opsIds(setup), log);

  // Provider and model only; never keys.
  logProviderSelected(log, config);
  logDeprecatedConfig(log, config);

  // A v1 db is snapshotted before its first migration; a failed snapshot aborts the start, db untouched.
  let db: ReturnType<typeof openDb>;
  try {
    db = openDb(workspacePaths(config.agentHome).dbFile);
  } catch (err) {
    return fail(errText(err));
  }
  // A crash leaves tasks "running"/"waiting_approval": they become "interrupted" (Resume button once ready).
  interruptRunningTurns(db);
  expireStaleProposals(db); // open proposals older than 24h; the rest get a `go` notice once ready
  const queuedThreads = releaseQueuedProposals(db); // queued tasks lost their run: back to `go`
  await runStartupHygiene(db, config.agentHome, config.cloneRetentionDays);
  // Fail closed: an invalid lexicon override, a duplicate role tag or INTENT_ENGINE=jev refuse the start.
  let intent: ReturnType<typeof buildIntentDeps>;
  try {
    intent = buildIntentDeps(config);
  } catch (err) {
    db.close();
    return fail(errText(err));
  }
  // Client is created after the handler, so the gateway looks it up lazily.
  let botClient: Client | undefined;
  const approvals = createDiscordApprovalGateway({
    getClient: () => botClient,
    ownerId: config.ownerDiscordId!,
    db,
  });
  const handleMessage = createTurnHandler({
    db,
    config,
    approvals,
    limiter: createRunLimiter(),
    intent,
  });
  const handleResume = createResumeHandler({
    db,
    getClient: () => botClient,
    ownerId: config.ownerDiscordId!,
    handleMessage,
    guildId: config.discordGuildId,
  });
  // One interaction listener: each handler ignores buttons of the other (different customId prefix).
  const { client } = createDiscordBot(
    config,
    handleMessage,
    async (i) => {
      await approvals.handleInteraction(i);
      await handleResume(i);
    },
    setup,
    handleMessage.memory,
  );
  botClient = client;
  // One #ops-log line per start / shutdown / uncaught error; no-op without ops.log in discord.yaml.
  const opsLog = createOpsLog(() => botClient, setup.ops.log);
  client.once(Events.ClientReady, () => {
    void postResumeNotices({ db, getClient: () => botClient });
    void postProposalNotices({ db, getClient: () => botClient, queuedThreads });
    warnIfBotAdministrator(client, config.discordGuildId);
    void opsLog.post("start", `pid=${process.pid} v${pkg.version}`);
  });

  /** Reason of the shutdown in progress (set by the shutdown log hook, shown in #ops-log). */
  let closeReason = "unknown";
  /** Graceful shutdown: abort + await runs, drop the connection, close db. */
  const shutdown = createShutdown({
    drain: handleMessage.drain,
    destroyClient: async () => {
      await opsLog.post("shutdown", closeReason);
      await client.destroy();
    },
    closeDb: () => db.close(),
    log: (m) => {
      closeReason = m.replace(/^shutting down: /, "");
      logEvent(log, "app.shutdown", { reason: m });
    },
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
    void opsLog.post("error", e).then(() => shutdown("unhandledRejection", 1));
  });
  process.on("uncaughtException", (e) => {
    log.error({ err: errText(e) }, "uncaught exception");
    void opsLog.post("error", e).then(() => shutdown("uncaughtException", 1));
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
    intentEngine: config.intent.engine,
    agentHome: config.agentHome,
    pid: process.pid,
  });
}

void main();
