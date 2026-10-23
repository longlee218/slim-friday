import { type Client, Events } from "discord.js";
import pkg from "../package.json";
import { TEAMMATE_POOL_MAX, TEAMMATE_WAITING_MAX, WORKER_POOL_MAX } from "./config/run-caps";
import { workspacePaths } from "./config/workspace-paths";
import { threadLanguage } from "./ingress/thread-language";
import { createThreadsPort } from "./ingress/threads-port";
import { type BootState, loadBootState } from "./lifecycle/boot-checks";
import { startDbRetention } from "./lifecycle/db-retention-sweeper";
import { startHomeRetention } from "./lifecycle/home-retention-sweeper";
import { createShutdown } from "./lifecycle/shutdown";
import { runStartupHygiene } from "./lifecycle/startup";
import { startTrashSweeper } from "./lifecycle/trash-sweeper";
import { logEvent, logger } from "./observability/logger";
import { logPromptDumpEnabled } from "./observability/prompt-dump";
import { errText } from "./observability/redact";
import { createTurnHandler } from "./orchestrator/handle-message";
import { createLimitsView } from "./orchestrator/turns/limits-live";
import { createPlanLookup } from "./orchestrator/turns/plan-live";
import { createRunLimiter } from "./orchestrator/turns/run-limiter";
import { recoverInFlight } from "./orchestrator/worker/recover-in-flight";
import { createDiscordApprovalGateway } from "./providers/discord/approval/discord-approval";
import { createDiscordBot } from "./providers/discord/ingress/discord-bot";
import { sendReply } from "./providers/discord/ingress/discord-message-handler";
import { openPeerThread } from "./providers/discord/ingress/peer-thread";
import { createThreadTitlePort } from "./providers/discord/ingress/thread-rename";
import { syncChannelTopics } from "./providers/discord/setup/channel-topic";
import { opsIds, readDiscordSetup } from "./providers/discord/setup/discord-setup-config";
import { createOpsLog } from "./providers/discord/setup/ops-log";
import { warnIfBotAdministrator } from "./providers/discord/setup/ready-checks";
import { warnOpsChannelsInWorkspaces } from "./providers/discord/setup/warn-ops-channels";
import { openDb } from "./storage/db";
import { archiveOrphanTeammates } from "./teammates/teammate-orphan-check";
import { appRoots } from "./viewer/viewer-roots";
import { startViewer } from "./viewer/viewer-server";

const log = logger.child({ module: "index" });

/** Log a fatal startup error (names only, never values) and exit. */
function fail(message: string): never {
  log.error(message);
  process.exit(1);
}

/** Boot: config, db, Discord login, graceful shutdown. */
async function main(): Promise<void> {
  let boot: BootState;
  try {
    boot = loadBootState();
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err));
  }
  const { config } = boot;
  // An unparsable discord.yaml could hide the ops/control channels, so refuse to start.
  let setup: ReturnType<typeof readDiscordSetup>;
  try {
    setup = readDiscordSetup(config.agentHome);
    warnOpsChannelsInWorkspaces(boot.workspaces, opsIds(setup), log);
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err));
  }

  // Opening applies the Drizzle migrations; an old-format db is refused, untouched.
  let db: ReturnType<typeof openDb>;
  try {
    db = openDb(workspacePaths(config.agentHome).dbFile);
  } catch (err) {
    return fail(errText(err));
  }
  // A crash leaves tasks "running"/"waiting_approval": they become "interrupted", each
  // running owned task is announced by a `recovered_after_restart` event, stale event claims are released.
  const recovery = recoverInFlight(db);
  await runStartupHygiene(db, config.agentHome);
  // A teammate whose channel left every workspace.yaml is archived (the row stays for the history).
  const orphans = archiveOrphanTeammates(
    db,
    boot.workspaces.flatMap((w) => w.channels),
  );
  if (orphans.length) logEvent(log, "teammates.orphans_archived", { names: orphans }, "warn");
  // The artifact viewer (read-only, 127.0.0.1) runs only when VIEWER_SECRET and VIEWER_BASE_URL are set; a taken port is fatal.
  let viewer: ReturnType<typeof startViewer> | undefined;
  if (config.viewer) {
    try {
      viewer = startViewer({ db, config: config.viewer, roots: appRoots(config.agentHome) });
    } catch (err) {
      return fail(`viewer failed to start: ${errText(err)}`);
    }
  }
  startTrashSweeper(config.agentHome); // boot sweep + every 6h: trash entries past 7 days go
  startDbRetention(db, config.agentHome); // boot sweep + every 6h: finished history past DB_RETENTION_DAYS goes (and the copies of reported files)
  startHomeRetention(config.agentHome); // boot sweep + every 6h: old task logs, app logs and run dirs go
  // Client is created after the handler, so the gateway looks it up lazily.
  let botClient: Client | undefined;
  const approvals = createDiscordApprovalGateway({
    getClient: () => botClient,
    // biome-ignore lint/style/noNonNullAssertion: checked at startup
    ownerId: config.ownerDiscordId!,
    db,
  });
  const limiter = createRunLimiter(WORKER_POOL_MAX);
  const teammatePool = createRunLimiter(TEAMMATE_POOL_MAX, TEAMMATE_WAITING_MAX);
  const handleMessage = createTurnHandler({
    db,
    config,
    approvals,
    limiter,
    teammatePool,
    threadTitle: createThreadTitlePort(() => botClient),
    // The teammate's boot wake has no owner message to answer through: post into the thread by id.
    openThread: (channelId, name) => openPeerThread(botClient, channelId, name),
    post: async (threadId, text) => {
      const channel = await botClient?.channels.fetch(threadId);
      if (channel?.isSendable()) await sendReply(channel, text, threadLanguage(db, threadId));
    },
  });
  const threadsPort = createThreadsPort(db, config.agentHome);
  const { client } = createDiscordBot(
    config,
    db,
    Object.assign(handleMessage, {
      limits: createLimitsView(db, limiter, teammatePool),
      plan: createPlanLookup({ db, home: config.agentHome, viewer: config.viewer }),
    }), // the bot reads `limits` (/limits) and `plan` (/plan)
    (i) => approvals.handleInteraction(i),
    setup,
    handleMessage.inline,
    threadsPort,
  );
  botClient = client;
  // One #ops-log line per start / shutdown / uncaught error; no-op without ops.log in discord.yaml.
  const opsLog = createOpsLog(() => botClient, setup.ops.log);
  client.once(Events.ClientReady, () => {
    handleMessage.wake(recovery); // threads with undelivered work wake their teammate
    warnIfBotAdministrator(client, config.discordGuildId);
    void syncChannelTopics(client, config.agentHome, opsIds(setup)); // never blocks the start
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
    closeDb: () => {
      viewer?.stop();
      db.close();
    },
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
      // biome-ignore lint/style/noNonNullAssertion: login only runs with a token
      { err: errText(err).replaceAll(config.discordToken!, "[REDACTED]") },
      "discord login failed",
    );
    db.close();
    process.exit(1);
  }
  logPromptDumpEnabled(config);
  logEvent(log, "app.started", {
    model: config.model,
    agentHome: config.agentHome,
    pid: process.pid,
  });
}

void main();
