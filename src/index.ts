import { homedir } from "node:os";
import { type Client, Events } from "discord.js";
import pkg from "../package.json";
import { type AgentConfig, loadConfig } from "./config/agent-config";
import { readProcessEnv } from "./config/process-env";
import { workspacePaths } from "./config/workspace-paths";
import { syncChannelTopics } from "./discord-setup/channel-topic";
import { createControlRoleRun } from "./discord-setup/control-role-run";
import { opsIds, readDiscordSetup } from "./discord-setup/discord-setup-config";
import { createOpsLog } from "./discord-setup/ops-log";
import { warnIfBotAdministrator } from "./discord-setup/ready-checks";
import { warnOpsChannelsInWorkspaces } from "./discord-setup/warn-ops-channels";
import { createDiscordBot } from "./ingress/discord-bot";
import { threadLanguage } from "./ingress/discord-components";
import { sendReply } from "./ingress/discord-message-handler";
import { createThreadTitlePort } from "./ingress/thread-rename";
import { createThreadsPort } from "./ingress/threads-port";
import { homePlacementError } from "./lifecycle/home-placement-check";
import { registryError } from "./lifecycle/registry-check";
import { createShutdown } from "./lifecycle/shutdown";
import { runStartupHygiene } from "./lifecycle/startup";
import { startTrashSweeper } from "./lifecycle/trash-sweeper";
import { real } from "./locations/location-registry";
import { ensureHome } from "./memory/persona";
import { logEvent, logger } from "./observability/logger";
import { errText } from "./observability/redact";
import { createTurnHandler } from "./orchestrator/handle-message";
import { createRunLimiter } from "./orchestrator/turns/run-limiter";
import { recoverInFlight } from "./orchestrator/worker/recover-in-flight";
import { createDiscordApprovalGateway } from "./owner-approval/discord-approval";
import { openDb } from "./storage/db";
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
    config = loadConfig(readProcessEnv(), { requireDiscord: true });
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err));
  }

  // Fail fast: there is no real credential (name only, never a key), or a role definition is invalid.
  if (!config.hasRealAuth) return fail(`CLAUDE_CODE_OAUTH_TOKEN missing or placeholder`);
  const badRole = registryError();
  if (badRole) return fail(`Invalid role registry: ${badRole}`);

  const { workspaces } = loadWorkspaces(config.agentHome);

  // Fail closed: the home (persona, memory, db, logs) must not live inside a location or a git working tree.
  // A location equal to the owner's $HOME is allowed: the guard denies AGENT_HOME to every run instead.
  const userHomes = [homedir(), readProcessEnv().HOME ?? ""].filter(Boolean).map(real);
  const misplaced = homePlacementError(
    config.agentHome,
    workspaces.flatMap((w) =>
      w.locations.map((r) => r.path).filter((p) => !userHomes.includes(real(p))),
    ),
  );
  if (misplaced) return fail(misplaced);

  // Create the missing root persona/memory files (and per-workspace/location memory) once at startup, never
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
  const handleMessage = createTurnHandler({
    db,
    config,
    approvals,
    limiter: createRunLimiter(),
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
    Object.assign(handleMessage, { control }), // the bot reads `control` for #ops-control text
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
    model: config.model,
    agentHome: config.agentHome,
    pid: process.pid,
  });
}

void main();
