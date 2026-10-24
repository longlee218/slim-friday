import { type OverwriteResolvable, OverwriteType, PermissionFlagsBits as P } from "discord.js";

/**
 * Permission overwrites for a private channel: `@everyone` (its id is the guild id) cannot see it,
 * the owner can read and write, the app can also manage webhooks and the channel.
 * Each overwrite names its `type`: without it discord.js looks the id up in its cache, and the owner is not cached
 * (no member intent), which fails with "Supplied parameter is not a cached User or Role".
 */
export function privateOverwrites(
  guildId: string,
  ownerId: string,
  appUserId: string,
): OverwriteResolvable[] {
  const talk = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory];
  return [
    { id: guildId, type: OverwriteType.Role, deny: [P.ViewChannel] },
    { id: ownerId, type: OverwriteType.Member, allow: talk },
    {
      id: appUserId,
      type: OverwriteType.Member,
      allow: [...talk, P.ManageWebhooks, P.ManageChannels],
    },
  ];
}
