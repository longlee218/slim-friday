import type { Client, Guild } from "discord.js";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { loadWorkspaces } from "../workspaces/workspace-registry";

const log = logger.child({ module: "channel-topic" });

/** Topic of a task channel: a mention opens a thread. */
export const TASK_TOPIC = "🧵 task: @Friday để mở thread";
/** Topic of a chat channel: plain messages are answered, no mention needed. */
export const CHAT_TOPIC = "💬 chat: nhắn thẳng, không cần @Friday";

/** The channel topic that tells the owner how the channel mode works. */
export const channelTopic = (mode: "task" | "chat"): string =>
  mode === "chat" ? CHAT_TOPIC : TASK_TOPIC;

/**
 * Set the topic of a channel just created. Best effort: a failure (e.g. missing Manage Channels) is logged
 * as a warning and never fails the command.
 */
export async function setChannelTopic(
  guild: Guild,
  channelId: string,
  mode: "task" | "chat",
): Promise<void> {
  try {
    await guild.channels.edit(channelId, { topic: channelTopic(mode) });
  } catch (err) {
    logEvent(log, "admin.topic_failed", { channelId, err: errText(err) }, "warn");
  }
}

/**
 * On start: set the topic of every configured channel whose topic is empty or a bot topic of the other mode (an owner-edited topic is kept; a rename
 * is skipped when equal, so Discord's topic rate limit is spared). Best effort: any failure is a warning
 * and never blocks the start. Returns the ids it changed.
 */
export async function syncChannelTopics(
  client: Client,
  home: string,
  skip: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const changed: string[] = [];
  try {
    for (const w of loadWorkspaces(home).workspaces)
      for (const def of w.channelDefs) {
        try {
          if (skip.has(def.id)) continue; // ops/control channels are never touched
          const ch = await client.channels.fetch(def.id);
          if (!ch || !("topic" in ch) || ch.topic === channelTopic(def.mode)) continue;
          // An owner-edited topic is never overwritten: only an empty or a bot-made topic is replaced.
          if (ch.topic && ch.topic !== TASK_TOPIC && ch.topic !== CHAT_TOPIC) continue;
          await ch.setTopic(channelTopic(def.mode));
          changed.push(def.id);
        } catch (err) {
          logEvent(log, "admin.topic_failed", { channelId: def.id, err: errText(err) }, "warn");
        }
      }
  } catch (err) {
    logEvent(log, "admin.topic_failed", { err: errText(err) }, "warn");
  }
  return changed;
}
