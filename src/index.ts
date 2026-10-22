import { type Client, Events } from "discord.js";
import pkg from "../package.json";
import { LEAD_POOL_MAX, LEAD_WAITING_MAX, WORKER_POOL_MAX } from "./config/run-caps";
import { workspacePaths } from "./config/workspace-paths";
import { threadLanguage } from "./ingress/thread-language";
import { createThreadsPort } from "./ingress/threads-port";
import { type BootState, loadBootState } from "./lifecycle/boot-checks";
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
import { createThreadTitlePort } from "./providers/discord/ingress/thread-rename";
import { syncChannelTopics } from "./providers/discord/setup/channel-topic";
import { createControlRoleRun } from "./providers/discord/setup/control-role-run";
import { opsIds } from "./providers/discord/setup/discord-setup-config";
import { createOpsLog } from "./providers/discord/setup/ops-log";
import { warnIfBotAdministrator } from "./providers/discord/setup/ready-checks";
import { openDb } from "./storage/db";
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
    boot = loadBootState(log);
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err));
  }
  const { config, setup } = boot;

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
  // Client is created after the handler, so the gateway looks it up lazily.
  let botClient: Client | undefined;
  const approvals = createDiscordApprovalGateway({
    getClient: () => botClient,
    ownerId: config.ownerDiscordId!,
    db,
  });
  // Non-command owner text of #ops-control runs the control-channel role (no workspace); built here so orchestrator never imports discord-setup.
  const control = createControlRoleRun({ db, config, approvals });
  const limiter = createRunLimiter(WORKER_POOL_MAX);
  const leadPool = createRunLimiter(LEAD_POOL_MAX, LEAD_WAITING_MAX);
  const handleMessage = createTurnHandler({
    db,
    config,
    approvals,
    limiter,
    leadPool,
    control, // shutdown hooks of the control runner
    threadTitle: createThreadTitlePort(() => botClient),
    // The lead's boot wake has no owner message to answer through: post into the thread by id.
    post: async (threadId, text) => {
      const channel = await botClient?.channels.fetch(threadId);
      if (channel?.isSendable()) await sendReply(channel, text, threadLanguage(db, threadId));
    },
  });
  const threadsPort = createThreadsPort(db, config.agentHome);
  const { client } = createDiscordBot(
    config,
    Object.assign(handleMessage, {
      control,
      limits: createLimitsView(db, limiter, leadPool),
      plan: createPlanLookup({ db, home: config.agentHome, viewer: config.viewer }),
    }), // the bot reads `control` (#ops-control text), `limits` (/limits) and `plan` (/plan)
    (i) => approvals.handleInteraction(i),
    setup,
    handleMessage.inline,
    threadsPort,
  );
  botClient = client;
  // One #ops-log line per start / shutdown / uncaught error; no-op without ops.log in discord.yaml.
  const opsLog = createOpsLog(() => botClient, setup.ops.log);
  client.once(Events.ClientReady, () => {
    handleMessage.wake(recovery); // threads with undelivered work wake their lead
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
