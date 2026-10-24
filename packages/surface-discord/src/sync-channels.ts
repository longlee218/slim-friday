import type { Bot, Conversation, Group } from "@friday/core";
import { parseTopic, topicFor } from "./channel-topic";
import type { ChannelTarget, DiscordPort } from "./discord-port";
import type { DiscordSurface } from "./discord-surface";

/** Name of the category that holds the channels. */
export const CATEGORY_NAME = "Friday";

/** What a sync did. */
export interface SyncResult {
  /** The conversation of every channel that is mapped now (reused and created). */
  conversations: Conversation[];
  /** Only the conversations whose channel was created by this sync. */
  created: Conversation[];
  /** One text per failure; a failure never stops the rest. */
  errors: string[];
}

/** Message of an error value. */
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The conversation a channel stands for. */
function conversationOf(channelId: string, t: ChannelTarget): Conversation {
  return t.kind === "bot"
    ? { id: channelId, kind: "direct", botId: t.botId }
    : { id: channelId, kind: "group", groupId: t.groupId };
}

/**
 * Give every loaded bot and group a private channel under the `Friday` category and map it on the surface.
 * A channel is found by its topic (`friday:bot:<id>` / `friday:group:<id>`), so a restart reuses the same
 * channels. Channels of removed bots and groups are left alone and not mapped.
 */
export async function syncChannels(
  port: DiscordPort,
  surface: DiscordSurface,
  bots: Bot[],
  groups: Group[],
): Promise<SyncResult> {
  const result: SyncResult = { conversations: [], created: [], errors: [] };
  const wanted = new Map<string, { target: ChannelTarget; name: string }>();
  for (const b of bots)
    wanted.set(topicFor({ kind: "bot", botId: b.id }), {
      target: { kind: "bot", botId: b.id },
      name: b.name.toLowerCase(),
    });
  for (const g of groups)
    wanted.set(topicFor({ kind: "group", groupId: g.id }), {
      target: { kind: "group", groupId: g.id },
      name: g.id,
    });

  const channels = await port.listChannels();
  for (const ch of channels) {
    const target = parseTopic(ch.topic);
    if (!target || !wanted.has(topicFor(target))) continue;
    surface.mapChannel(ch.id, target);
    result.conversations.push(conversationOf(ch.id, target));
    wanted.delete(topicFor(target));
  }
  if (wanted.size === 0) return result;

  let categoryId = channels.find((c) => c.name === CATEGORY_NAME && !c.topic && !c.parentId)?.id;
  try {
    categoryId ??= await port.createCategory(CATEGORY_NAME);
  } catch (err) {
    result.errors.push(`category: ${why(err)}`);
    return result;
  }
  for (const [topic, { target, name }] of wanted) {
    try {
      const id = await port.createPrivateChannel(name, categoryId, topic);
      surface.mapChannel(id, target);
      const conv = conversationOf(id, target);
      result.conversations.push(conv);
      result.created.push(conv);
    } catch (err) {
      result.errors.push(`${topic}: ${why(err)}`);
    }
  }
  return result;
}
