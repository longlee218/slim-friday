import { ChannelType, type Client } from "discord.js";

/** Auto-archive of a peer thread (minutes): one day, like the owner's own task threads. */
const PEER_THREAD_ARCHIVE_MINUTES = 1440;

/**
 * Open a new thread in a teammate's text channel for a peer request (no message to start it from). The bot owns it, so the
 * owner can answer in it without a mention like in any bot thread. Throws when the channel is gone or not a text channel.
 */
export async function openPeerThread(
  client: Client | undefined,
  channelId: string,
  name: string,
): Promise<string> {
  const channel = await client?.channels.fetch(channelId);
  if (channel?.type !== ChannelType.GuildText)
    throw new Error("teammate channel is not a text channel");
  const thread = await channel.threads.create({
    name,
    autoArchiveDuration: PEER_THREAD_ARCHIVE_MINUTES,
  });
  return thread.id;
}
