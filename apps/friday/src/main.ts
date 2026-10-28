import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ticketChangePublisher } from "@friday/api";
import type { FileConfig } from "@friday/config";
import type { AgentRuntime, FileStore } from "@friday/core";
import { consolidateNotes, extractNotes } from "@friday/runtime-claude";
import { R2FileStore } from "@friday/store-r2";
import { openEngineStore } from "@friday/store-sqlite";
import { WebSurface } from "@friday/surface-web";
import { localDay, purgeTrash } from "@friday/tools";
import { startApiServer } from "./api-server";
import type { RuntimeParts } from "./app-deps";
import { appAutoReviewer } from "./auto-reviewer";
import { claudeRuntimeFactory } from "./claude-runtime-factory";
import type { AgentConfig } from "./config/agent-config";
import { HAIKU_SUMMARY_MODEL } from "./config/model-ids";
import { readProcessEnv } from "./config/process-env";
import { acquireMainLock } from "./lifecycle/main-lock";
import type { ToolWarning } from "./lifecycle/tool-check";
import { startMcpProxy } from "./mcp-oauth/mcp-proxy";
import { mcpAuthAdmin, startOAuthUpkeep } from "./mcp-oauth/oauth-api";
import { McpOAuthManager } from "./mcp-oauth/oauth-manager";
import { oauthConfs, withProxiedServers } from "./mcp-oauth/oauth-servers";
import { logEvent, logger } from "./observability/logger";
import { registrableDomain } from "./registrable-domain";
import { need, r2Of } from "./required-config";
import { deniedEnvValues } from "./secret-values";
import { createSettings } from "./settings-admin";
import { startApp } from "./start-app";
import { systemClock } from "./system-clock";
import { bootId } from "./workers/boot-id";
import { workerLauncher } from "./workers/worker-spawn";

const log = logger.child({ module: "engine" });

/** Test seams of `startEngine`; any of them runs the runs in the main process (no workers). */
interface EngineOverrides {
  /** Replaces the Claude runtime (the e2e script passes a scripted one). */
  runtime?: AgentRuntime | ((parts: RuntimeParts) => AgentRuntime);
  /** Replaces the R2 file store (the e2e script passes an in-memory one). */
  fileStore?: FileStore;
}

/**
 * Run the bot engine on the web surface until `signal` aborts: R2 file store, engine db, web surface, Claude runtime,
 * the app, then the web API over them. Refuses by variable name, before any network call, when a web or R2 value is
 * missing.
 */
export async function startEngine(
  opts: {
    config: AgentConfig;
    agentHome: string;
    signal: AbortSignal;
    /** Missing tools found at boot; the API reports them (default none). */
    toolWarnings?: ToolWarning[];
  },
  overrides?: EngineOverrides,
): Promise<void> {
  const { config, agentHome, signal, toolWarnings = [] } = opts;
  const web = {
    webOrigin: need("WEB_ORIGIN", config.webOrigin),
    extraWebOrigins: config.extraWebOrigins,
    publicApiUrl: need("PUBLIC_API_URL", config.publicApiUrl),
    authSecret: need("AUTH_SECRET", config.authSecret),
    ownerEmail: need("OWNER_EMAIL", config.ownerEmail),
  };
  const r2 = r2Of(config);
  // One main per agent home (a second one exits 1 with the holder's pid); released when the engine stops.
  const releaseLock = acquireMainLock(agentHome);
  try {
    await runEngine(config, agentHome, signal, web, r2, toolWarnings, overrides);
  } finally {
    releaseLock();
  }
}

/** `startEngine` once the values are checked and the main lock is held. */
async function runEngine(
  config: AgentConfig,
  agentHome: string,
  signal: AbortSignal,
  web: {
    webOrigin: string;
    extraWebOrigins: string[];
    publicApiUrl: string;
    authSecret: string;
    ownerEmail: string;
  },
  r2: ReturnType<typeof r2Of>,
  toolWarnings: ToolWarning[],
  overrides?: EngineOverrides,
): Promise<void> {
  // The S3 client is lazy: nothing reaches R2 until a file is read or written.
  const files = overrides?.fileStore ?? new R2FileStore(r2);
  mkdirSync(join(agentHome, "data"), { recursive: true });
  const engine = openEngineStore(join(agentHome, "data", "engine.db"));
  const surface = new WebSurface({
    store: engine,
    files,
    clock: systemClock,
    inboxDir: join(agentHome, "inbox"),
    log,
  });
  const env = readProcessEnv();
  const claudeRuntime = claudeRuntimeFactory(config, agentHome, log);
  /** The one-turn Haiku call shared by the note extraction and the consolidation. */
  const haiku = { model: HAIKU_SUMMARY_MODEL, env, oauthToken: config.oauthToken };
  // OAuth MCP servers: the manager holds the logins (rows in the engine db), the proxy gives sessions a local url.
  // The server list is read from the config the app loads (set when the runtime is built, before any request).
  let appConfig: FileConfig | undefined;
  const oauthServers = () => oauthConfs(appConfig?.mcpServers(env).servers ?? {});
  const oauth = new McpOAuthManager({ store: engine.mcpOAuth, servers: oauthServers, log });
  const mcpProxy = startMcpProxy({ manager: oauth, servers: oauthServers, log });
  const baseRuntime = overrides?.runtime ?? claudeRuntime;
  /** The runtime over parts whose MCP servers go through the proxy. */
  const runtime = (parts: RuntimeParts): AgentRuntime => {
    appConfig = parts.config;
    const proxied = withProxiedServers(parts, mcpProxy);
    return typeof baseRuntime === "function" ? baseRuntime(proxied) : baseRuntime;
  };
  // A failed start leaves no open db.
  const app = await startApp({
    surface,
    files,
    engine,
    runtime,
    agentHome,
    log,
    env,
    autoReviewer: appAutoReviewer(config),
    flushNotes: (transcript, ctx) =>
      extractNotes(transcript, {
        ...haiku,
        source: "transcript",
        today: localDay(new Date()),
        ...ctx,
      }),
    consolidate: (memory, notes, known) =>
      consolidateNotes({ memory, notes, known, today: localDay(new Date()) }, haiku),
    onConfigChanged: () => surface.bus.publish({ type: "config.changed" }),
    // `limits.workers` worker processes run the runs (0: this process does). An override (the e2e script) runs
    // them in this process: workers would build the real runtime and file store.
    ...(!overrides && {
      workers: workerLauncher({
        bootId: bootId(),
        config: { ...config, agentHome },
        mcpProxy: mcpProxy.endpoint,
      }),
    }),
    // Every saved ticket change goes to the web app with its fresh comment count.
    onTicketChange: ticketChangePublisher({ store: engine, bus: surface.bus, log }),
    // A schedule a bot or the owner changed refreshes the web's schedule list.
    onScheduleChange: (id) => surface.bus.publish({ type: "schedule", id }),
  }).catch(async (err) => {
    // startApp closes what it opened; closing the db here too is harmless and covers a throw before it took it.
    await mcpProxy.stop();
    engine.close();
    throw err;
  });
  // Sign-in changes go to the web app; servers that need a login are logged; connected ones refresh daily.
  const stopUpkeep = startOAuthUpkeep({
    manager: oauth,
    servers: oauthServers,
    bus: surface.bus,
    log,
  });
  // The web API over the running engine; a failed start stops the app.
  const api = await startApiServer({
    agentHome,
    port: config.apiPort,
    ...web,
    cdnUrl: config.cdnUrl,
    log,
    engine: {
      hub: app.hub,
      store: app.store,
      surface,
      files,
      purge: () => purgeTrash(agentHome),
      toolWarnings,
      settings: createSettings({
        config: app.config,
        agentHome,
        memory: app.memory,
        capChars: app.config.limits().memoryPromptChars,
        env,
        pathEnv: env.PATH ?? "",
        mcpProxy,
      }),
      mcpAuth: mcpAuthAdmin(oauth, engine.mcpOAuth, web.publicApiUrl),
      registrableDomain,
      tools: app.config.catalog,
      // The same denied env values the engine hides from bot text (read at each call).
      secretValues: () => deniedEnvValues(),
      limits: () => app.config.limits(),
    },
  }).catch(async (err) => {
    stopUpkeep();
    await mcpProxy.stop();
    await app.stop();
    throw err;
  });
  logEvent(log, "engine.started", { agentHome });
  if (!signal.aborted)
    await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
  // Open cards stay open: they are rows, shown again at the next start. The API stops first, then the app.
  stopUpkeep();
  try {
    await api.stop();
  } finally {
    try {
      await app.stop();
    } finally {
      // Last: runs still draining in app.stop() keep their MCP access.
      await mcpProxy.stop();
    }
  }
}
