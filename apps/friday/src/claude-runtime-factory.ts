import { join } from "node:path";
import { TEMPLATES_DIR } from "@friday/config";
import { type AgentRuntime, type Log, redactSecrets } from "@friday/core";
import { ClaudeRuntime, extractNotes, isSensitivePath } from "@friday/runtime-claude";
import { localDay } from "@friday/tools";
import type { RuntimeParts } from "./app-deps";
import type { AgentConfig } from "./config/agent-config";
import { HAIKU_SUMMARY_MODEL } from "./config/model-ids";
import { readProcessEnv } from "./config/process-env";
import { designContextFor } from "./design-context";
import { fridayExtraDirs } from "./friday-bot";
import { memoryFlush } from "./memory-flush";
import { deniedEnvValues } from "./secret-values";
import { sessionTools } from "./session-tools";
import { sessionSharedDirs } from "./shared-dirs";
import { skillDirs } from "./skills-dirs";

/**
 * The Claude runtime of a process that runs runs (a worker, or main in in-process mode): the SDK sessions,
 * the bot's tool servers (built per session, here, over this process's store, memory and surface) and the
 * note extraction after a compaction.
 */
export function claudeRuntimeFactory(config: AgentConfig, agentHome: string, log: Log) {
  const env = readProcessEnv();
  const memoryDir = join(agentHome, "memory");
  return (parts: RuntimeParts): AgentRuntime => {
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
      mcpServers: parts.mcpServers,
      mcpServersFor: sessionTools({
        design: designContextFor({ config: parts.config, agentHome }),
        memory: parts.memory,
        insight: parts.insight,
        recall: parts.recall,
        messages: parts.messages,
        store: parts.store,
        messenger: parts.messenger,
        tickets: parts.tickets,
        schedules: parts.schedules,
        groupIdsOf: parts.config.groupIdsOf,
        home: agentHome,
        projectsDir: parts.config.projectsDir,
        isSensitive: isSensitivePath,
        env,
        postFile: (conversationId, botId, file, caption) =>
          parts.surface.postFile(
            conversationId,
            { kind: "bot", botId },
            file,
            // The caption is bot text: hide the denied env's secrets like every other post.
            caption === undefined ? undefined : redactSecrets(caption, deniedEnvValues(env)),
          ),
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
}
