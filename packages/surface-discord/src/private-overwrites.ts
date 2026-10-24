import { type OverwriteResolvable, PermissionFlagsBits as P } from "discord.js";

/**
 * Permission overwrites for a private channel: `@everyone` (its id is the guild id) cannot see it,
 * the owner can read and write, the app can also manage webhooks and the channel.
 */
export function privateOverwrites(
  guildId: string,
  ownerId: string,
  appUserId: string,
): OverwriteResolvable[] {
  const talk = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory];
  return [
    { id: guildId, deny: [P.ViewChannel] },
    { id: ownerId, allow: talk },
    { id: appUserId, allow: [...talk, P.ManageWebhooks, P.ManageChannels] },
  ];
}
