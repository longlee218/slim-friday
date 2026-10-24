import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES_DIR } from "@friday/config";
import {
  ClaudeRuntime,
  consolidateNotes,
  extractNotes,
  isSensitivePath,
} from "@friday/runtime-claude";
import { R2FileStore } from "@friday/store-r2";
import { openEngineStore } from "@friday/store-sqlite";
import { WebSurface } from "@friday/surface-web";
import { localDay, purgeTrash } from "@friday/tools";
import { startApiServer } from "./api-server";
import type { AgentConfig } from "./config/agent-config";
import { HAIKU_SUMMARY_MODEL } from "./config/model-ids";
import { readProcessEnv } from "./config/process-env";
import { designContextFor } from "./design-context";
import { fridayExtraDirs } from "./friday-bot";
import { memoryFlush } from "./memory-flush";
import { logEvent, logger } from "./observability/logger";
import { sessionTools } from "./session-tools";
import { sessionSharedDirs } from "./shared-dirs";
import { skillDirs } from "./skills-dirs";
import { type RuntimeParts, startApp } from "./start-app";
import { systemClock } from "./system-clock";

const log = logger.child({ module: "engine" });

/** A required value: missing and the `REPLACE_ME` placeholder both count as absent. */
function need(name: string, value: string | undefined): string {
  if (!value || value === "REPLACE_ME") throw new Error(`${name} missing`);
  return value;
}

/**
 * Run the bot engine on the web surface until `signal` aborts: R2 file store, engine db, web surface, Claude runtime,
 * the app, then the web API over them. Refuses by variable name, before any network call, when a web or R2 value is
 * missing.
 */
export async function startEngine(opts: {
  config: AgentConfig;
  agentHome: string;
  signal: AbortSignal;
}): Promise<void> {
  const { config, agentHome, signal } = opts;
  const web = {
    webOrigin: need("WEB_ORIGIN", config.webOrigin),
    publicApiUrl: need("PUBLIC_API_URL", config.publicApiUrl),
    authSecret: need("AUTH_SECRET", config.authSecret),
    ownerEmail: need("OWNER_EMAIL", config.ownerEmail),
  };
  const r2 = {
    accountId: need("R2_ACCOUNT_ID", config.r2.accountId),
    accessKeyId: need("R2_ACCESS_KEY_ID", config.r2.accessKeyId),
    secretAccessKey: need("R2_SECRET_ACCESS_KEY", config.r2.secretAccessKey),
    bucket: need("R2_BUCKET", config.r2.bucket),
  };
  // The S3 client is lazy: nothing reaches R2 until a file is read or written.
  const files = new R2FileStore(r2);
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
  const memoryDir = join(agentHome, "memory");
  const runtime = (parts: RuntimeParts) => {
    // Missing env values are reported once at start; the servers are read again for every new session.
    for (const p of parts.config.mcpServers(env).problems) log.warn(p, "config.problem");
    return new ClaudeRuntime({
      oauthToken: config.oauthToken,
      agentHome,
      scratchRoot: join(agentHome, "scratch"),
      skillDirs: skillDirs(agentHome),
      env,
      // A group session gets that group's shared dir only; the direct session every group's.
      extraDirsFor: (bot, groupId) => {
        const friday = fridayExtraDirs(TEMPLATES_DIR)(bot);
        const shared = sessionSharedDirs(agentHome, parts.config.groupIdsOf)(bot.id, groupId);
        return { write: [...friday.write, ...shared], read: friday.read };
      },
      mcpServers: () => parts.config.mcpServers(env).servers,
      mcpServersFor: sessionTools({
        design: designContextFor({ config: parts.config, agentHome }),
        memory: parts.memory,
        insight: parts.insight,
        recall: parts.recall,
        messages: parts.messages,
        store: parts.store,
        messenger: parts.messenger,
        tickets: parts.tickets,
        groupIdsOf: parts.config.groupIdsOf,
        home: agentHome,
        projectsDir: parts.config.projectsDir,
        isSensitive: isSensitivePath,
        env,
        postFile: (conversationId, botId, file, caption) =>
          parts.surface.postFile(conversationId, { kind: "bot", botId }, file, caption),
      }),
      // After a compaction, keep what matters in the bot's journal (never in MEMORY.md, which the bot curates).
      onCompact: memoryFlush(
        memoryDir,
        (summary) =>
          extractNotes(summary, {
            model: HAIKU_SUMMARY_MODEL,
            env,
            oauthToken: config.oauthToken,
            today: localDay(new Date()),
          }),
        log,
        parts.memoryChanged,
      ),
    });
  };
  /** The one-turn Haiku call shared by the note extraction and the consolidation. */
  const haiku = { model: HAIKU_SUMMARY_MODEL, env, oauthToken: config.oauthToken };
  // A failed start leaves no open db.
  const app = await startApp({
    surface,
    files,
    engine,
    runtime,
    agentHome,
    log,
    env,
    flushNotes: (transcript) =>
      extractNotes(transcript, { ...haiku, source: "transcript", today: localDay(new Date()) }),
    consolidate: (memory, notes) =>
      consolidateNotes({ memory, notes, today: localDay(new Date()) }, haiku),
    onConfigChanged: () => surface.bus.publish({ type: "config.changed" }),
  }).catch((err) => {
    // startApp closes what it opened; closing the db here too is harmless and covers a throw before it took it.
    engine.close();
    throw err;
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
      listGroups: app.config.listGroups,
    },
  }).catch(async (err) => {
    await app.stop();
    throw err;
  });
  logEvent(log, "engine.started", { agentHome });
  if (!signal.aborted)
    await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
  // Open cards stay open: they are rows, shown again at the next start. The API stops first, then the app.
  try {
    await api.stop();
  } finally {
    await app.stop();
  }
}
