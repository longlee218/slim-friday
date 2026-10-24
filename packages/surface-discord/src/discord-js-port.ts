import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type TextChannel,
  type Webhook,
} from "discord.js";
import type {
  ButtonSpec,
  ChannelInfo,
  DiscordPort,
  IncomingClick,
  IncomingCommand,
  IncomingMessage,
} from "./discord-port";
import { privateOverwrites } from "./private-overwrites";

/** Name of the webhook the app creates in each channel. */
const WEBHOOK_NAME = "Friday";

/** Discord error code: the webhook no longer exists. */
const UNKNOWN_WEBHOOK = 10015;

/** Discord button styles by our style names. */
const STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  danger: ButtonStyle.Danger,
} as const;

/** The port plus a way to disconnect. */
export type ConnectedDiscord = DiscordPort & { close(): Promise<void> };

/** Log in, wait until ready, register the guild slash commands and return the port. */
export async function connectDiscord(opts: {
  token: string;
  guildId: string;
  ownerId: string;
  /** Receives client errors (without a listener a discord.js error event would crash the process). */
  onError?: (err: Error) => void;
}): Promise<ConnectedDiscord> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // Bot text may contain @everyone or mentions; never ping anyone.
    allowedMentions: { parse: [] },
  });
  client.on(Events.Error, (err) => opts.onError?.(err));
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(opts.token);
  await ready;
  const guild = await client.guilds.fetch(opts.guildId);
  await guild.commands.set([
    {
      name: "stop",
      description: "Stop a bot (this channel's bot when none is named)",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "bot",
          description: "Bot name",
          required: false,
        },
      ],
    },
    { name: "status", description: "Show what the bots in this channel are doing" },
    { name: "purge", description: "Empty the trash of deleted files now" },
  ]);

  /** A channel of the guild that can take text. */
  const textChannel = async (id: string): Promise<TextChannel> => {
    const ch = await client.channels.fetch(id);
    if (!ch || ch.type !== ChannelType.GuildText)
      throw new Error(`channel ${id} is not a text channel`);
    return ch;
  };

  // One webhook per channel, found or created once (the promise is cached, so two first posts share it).
  const hooks = new Map<string, Promise<Webhook>>();
  const webhookFor = (channelId: string): Promise<Webhook> => {
    let hook = hooks.get(channelId);
    if (!hook) {
      hook = (async () => {
        const ch = await textChannel(channelId);
        const mine = (await ch.fetchWebhooks()).find(
          (w) => w.name === WEBHOOK_NAME && w.owner?.id === client.user?.id,
        );
        return mine ?? (await ch.createWebhook({ name: WEBHOOK_NAME }));
      })();
      hooks.set(channelId, hook);
      // A failed lookup is not kept.
      hook.catch(() => hooks.delete(channelId));
    }
    return hook;
  };

  return {
    ownerId: opts.ownerId,
    onMessage(h: (m: IncomingMessage) => void) {
      client.on(Events.MessageCreate, (msg) => {
        if (msg.guildId !== opts.guildId || msg.channel.type !== ChannelType.GuildText) return;
        h({
          channelId: msg.channelId,
          authorId: msg.author.id,
          fromBotOrWebhook: msg.author.bot || msg.webhookId !== null,
          text: msg.content,
          attachments: [...msg.attachments.values()].map((a) => ({
            url: a.url,
            name: a.name,
            size: a.size,
            ...(a.contentType && { contentType: a.contentType }),
          })),
        });
      });
    },
    onClick(h: (c: IncomingClick) => void) {
      client.on(Events.InteractionCreate, (i) => {
        if (!i.isButton() || i.guildId !== opts.guildId) return;
        h({
          channelId: i.channelId,
          userId: i.user.id,
          customId: i.customId,
          ack: async () => {
            await i.deferUpdate();
          },
        });
      });
    },
    onCommand(h: (c: IncomingCommand) => void) {
      client.on(Events.InteractionCreate, (i) => {
        if (!i.isChatInputCommand() || i.guildId !== opts.guildId) return;
        if (i.commandName !== "stop" && i.commandName !== "status" && i.commandName !== "purge")
          return;
        h({
          channelId: i.channelId,
          userId: i.user.id,
          name: i.commandName,
          botName: i.options.getString("bot") ?? undefined,
          reply: async (text) => {
            await i.reply({ content: text, flags: MessageFlags.Ephemeral });
          },
        });
      });
    },
    async send(channelId, text) {
      await (await textChannel(channelId)).send(text);
    },
    async sendAs(channelId, username, text) {
      try {
        await (await webhookFor(channelId)).send({ content: text, username });
      } catch (err) {
        // The owner deleted the webhook: forget it and make a new one, once.
        if ((err as { code?: number }).code !== UNKNOWN_WEBHOOK) throw err;
        hooks.delete(channelId);
        await (await webhookFor(channelId)).send({ content: text, username });
      }
    },
    async typing(channelId) {
      await (await textChannel(channelId)).sendTyping();
    },
    async sendButtons(channelId, text, buttons: ButtonSpec[]) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.map((b) =>
          new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(STYLES[b.style]),
        ),
      );
      const msg = await (await textChannel(channelId)).send({ content: text, components: [row] });
      return msg.id;
    },
    async editMessage(channelId, messageId, text) {
      const msg = await (await textChannel(channelId)).messages.fetch(messageId);
      await msg.edit({ content: text, components: [] });
    },
    async listChannels(): Promise<ChannelInfo[]> {
      const all = await guild.channels.fetch();
      return [...all.values()].flatMap((c) =>
        c
          ? [
              {
                id: c.id,
                name: c.name,
                topic: "topic" in c && c.topic ? c.topic : undefined,
                parentId: c.parentId ?? undefined,
              },
            ]
          : [],
      );
    },
    async createCategory(name) {
      const c = await guild.channels.create({ name, type: ChannelType.GuildCategory });
      return c.id;
    },
    async createPrivateChannel(name, parentId, topic) {
      const c = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: parentId,
        topic,
        permissionOverwrites: privateOverwrites(guild.id, opts.ownerId, client.user?.id ?? ""),
      });
      return c.id;
    },
    async close() {
      await client.destroy();
    },
  };
}
