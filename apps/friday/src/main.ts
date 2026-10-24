import { join } from "node:path";
import { TEMPLATES_DIR } from "@friday/config";
import {
  ClaudeRuntime,
  consolidateNotes,
  extractNotes,
  isSensitivePath,
} from "@friday/runtime-claude";
import { connectDiscord } from "@friday/surface-discord";
import { localDay } from "@friday/tools";
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

  const port = await connect({
    token,
    guildId,
    ownerId,
    onError: (err) => log.error({ error: err.message }, "discord.error"),
  });
  try {
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
    const app = await startApp({
      port,
      runtime,
      agentHome,
      log,
      env,
      flushNotes: (transcript) =>
        extractNotes(transcript, { ...haiku, source: "transcript", today: localDay(new Date()) }),
      consolidate: (memory, notes) =>
        consolidateNotes({ memory, notes, today: localDay(new Date()) }, haiku),
    });
    logEvent(log, "engine.started", { agentHome });
    if (!signal.aborted)
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    await app.stop();
  } finally {
    await port.close();
  }
}
