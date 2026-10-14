import {
  ChannelType,
  type Guild,
  OverwriteType,
  PermissionFlagsBits as P,
  type PermissionsBitField,
} from "discord.js";

/** Permissions the owner gets in a private channel. */
export const OWNER_ALLOW = [
  P.ViewChannel,
  P.SendMessages,
  P.SendMessagesInThreads,
  P.ReadMessageHistory,
  P.AttachFiles,
];
/** Permissions the bot gets: the owner's plus thread creation and embeds. */
export const BOT_ALLOW = [...OWNER_ALLOW, P.CreatePublicThreads, P.EmbedLinks];
/**
 * Guild-level permissions the bot needs to create private channels: Manage Channels + Manage Roles (set
 * overwrites), and every permission it grants itself (a bot cannot grant what it does not hold).
 */
export const REQUIRED_BOT_PERMISSIONS = {
  ManageChannels: P.ManageChannels,
  ManageRoles: P.ManageRoles,
  ViewChannel: P.ViewChannel,
  SendMessages: P.SendMessages,
  SendMessagesInThreads: P.SendMessagesInThreads,
  CreatePublicThreads: P.CreatePublicThreads,
  ReadMessageHistory: P.ReadMessageHistory,
  AttachFiles: P.AttachFiles,
  EmbedLinks: P.EmbedLinks,
};

/** One permission overwrite as plain data (decoupled from discord.js objects so it can be tested). */
export interface Overwrite {
  id: string;
  type: OverwriteType;
  allow: bigint;
  deny: bigint;
}

/** Who the private shape is about. */
export interface PrivateIds {
  guildId: string;
  ownerId: string;
  botId: string;
}

/** OR a list of permission flags into one bitfield. */
const bits = (flags: bigint[]): bigint => flags.reduce((a, b) => a | b, 0n);

/** The only overwrites a private channel/category carries: @everyone denied, owner + bot allowed. */
export function privateOverwrites({ guildId, ownerId, botId }: PrivateIds): Overwrite[] {
  return [
    { id: guildId, type: OverwriteType.Role, allow: 0n, deny: P.ViewChannel }, // @everyone role id = guild id
    { id: ownerId, type: OverwriteType.Member, allow: bits(OWNER_ALLOW), deny: 0n },
    { id: botId, type: OverwriteType.Member, allow: bits(BOT_ALLOW), deny: 0n },
  ];
}

/**
 * Strict privacy test: EXACTLY the three overwrites of `privateOverwrites` semantics. @everyone is denied
 * View (and not allowed it); owner and bot hold at least their allow sets with none of them denied; any
 * other overwrite (another role or member, even deny-only) makes the channel not private.
 * Administrator / guild owner bypass overwrites by design; this cannot detect them.
 */
export function isPrivateOverwrites(overwrites: Overwrite[], ids: PrivateIds): boolean {
  if (overwrites.length !== 3) return false;
  const byId = new Map(overwrites.map((o) => [o.id, o]));
  const everyone = byId.get(ids.guildId);
  const owner = byId.get(ids.ownerId);
  const bot = byId.get(ids.botId);
  if (byId.size !== 3 || !everyone || !owner || !bot) return false;
  if (everyone.type !== OverwriteType.Role || owner.type !== OverwriteType.Member) return false;
  if (bot.type !== OverwriteType.Member) return false;
  if ((everyone.deny & P.ViewChannel) === 0n || (everyone.allow & P.ViewChannel) !== 0n)
    return false;
  const holds = (o: Overwrite, need: bigint) => (o.allow & need) === need && (o.deny & need) === 0n;
  return holds(owner, bits(OWNER_ALLOW)) && holds(bot, bits(BOT_ALLOW));
}

/** One cached overwrite as discord.js exposes it (fields `isPrivateChannel` reads). */
interface CachedOverwrite {
  id: string;
  type: OverwriteType;
  allow: PermissionsBitField;
  deny: PermissionsBitField;
}

/** The slice of a discord.js guild channel `isPrivateChannel` reads (cache is a Collection/Map). */
export interface ChannelWithOverwrites {
  permissionOverwrites: { cache: { values(): Iterable<CachedOverwrite> } };
}

/** Live privacy check of a cached guild channel (overwrites follow gateway updates). */
export function isPrivateChannel(channel: ChannelWithOverwrites, ids: PrivateIds): boolean {
  const overwrites = [...channel.permissionOverwrites.cache.values()].map((o) => ({
    id: o.id,
    type: o.type,
    allow: o.allow.bitfield,
    deny: o.deny.bitfield,
  }));
  return isPrivateOverwrites(overwrites, ids);
}

/**
 * Bot guild permissions: names of required permissions it lacks, and whether it holds Administrator.
 * Administrator satisfies every requirement (Discord implies all bits), but the caller still warns.
 */
export function botPermissionReport(guildPerms: bigint): {
  missing: string[];
  administrator: boolean;
} {
  const administrator = (guildPerms & P.Administrator) !== 0n;
  const missing = administrator
    ? []
    : Object.entries(REQUIRED_BOT_PERMISSIONS)
        .filter(([, flag]) => (guildPerms & flag) === 0n)
        .map(([name]) => name);
  return { missing, administrator };
}

/** A channel as the existence check sees it. */
export interface ChannelRef {
  id: string;
  name: string;
  type: ChannelType;
}

/**
 * First channel of `type` named `name` (case-insensitive: Discord lowercases text channel names). With
 * `parentId` only channels under that category count; without it the whole guild is searched.
 */
export function findExisting(
  channels: (ChannelRef & { parentId?: string | null })[],
  name: string,
  type: ChannelType,
  parentId?: string,
) {
  return channels.find(
    (c) =>
      c.type === type &&
      c.name.toLowerCase() === name.toLowerCase() &&
      (parentId === undefined || c.parentId === parentId),
  );
}

/** Outcome of one create-only call. */
export type CreateResult = { status: "created"; id: string } | { status: "exists"; id: string };

/** Every guild channel as plain refs (fresh fetch). */
export async function listGuildChannels(
  guild: Guild,
): Promise<(ChannelRef & { parentId: string | null })[]> {
  const all = await guild.channels.fetch();
  return [...all.values()].flatMap((c) =>
    c ? [{ id: c.id, name: c.name, type: c.type, parentId: c.parentId }] : [],
  );
}

/**
 * Create a private category or text channel. CREATE-ONLY: a category/channel of that name already in the
 * guild is reported as "exists" and left untouched (never adopted, edited or deleted). With `spec.parentId`
 * only that category is searched (a same-named channel elsewhere is no conflict); else the whole guild.
 */
export async function createPrivate(
  guild: Guild,
  existing: (ChannelRef & { parentId?: string | null })[],
  spec: { name: string; kind: "category" | "text"; parentId?: string },
  ids: PrivateIds,
): Promise<CreateResult> {
  const type = spec.kind === "category" ? ChannelType.GuildCategory : ChannelType.GuildText;
  const found = findExisting(existing, spec.name, type, spec.parentId);
  if (found) return { status: "exists", id: found.id };
  const created = await guild.channels.create({
    name: spec.name,
    type,
    ...(spec.parentId ? { parent: spec.parentId } : {}),
    permissionOverwrites: privateOverwrites(ids),
  } as Parameters<Guild["channels"]["create"]>[0]);
  return { status: "created", id: created.id };
}
