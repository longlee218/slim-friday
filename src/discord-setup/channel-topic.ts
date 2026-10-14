import type { Guild } from "discord.js";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";

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
