import {
  type ChatInputCommandInteraction,
  type Client,
  Collection,
  type Message,
  MessageFlags,
} from "discord.js";
import { slashPayload, slashText } from "../commands/slash-definitions";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { SAFE_MENTIONS } from "./discord-message-rules";

const log = logger.child({ module: "slash-interaction" });

/** Register the native commands: the pinned guild when set (instant), else global. Never throws. */
export async function registerSlashCommands(client: Client, guildId?: string): Promise<void> {
  try {
    const payload = slashPayload();
    // Bulk overwrite: the picker then shows exactly this set.
    if (guildId) await client.application?.commands.set(payload as never, guildId);
    else await client.application?.commands.set(payload as never);
    logEvent(log, "slash.registered", {
      count: payload.length,
      scope: guildId ? "guild" : "global",
    });
  } catch (err) {
    log.error({ err: errText(err) }, "slash command registration failed");
  }
}

/**
 * Adapter: the slash interaction seen as the owner's `Message` (mention implied, text `/name arg`), so the
 * message handler's routing, owner/guild/ops/admin gates and command parsers run unchanged. Replies go through
 * the interaction; anything the handler posts with `channel.send` lands in the channel as before.
 */
function asMessage(
  i: ChatInputCommandInteraction,
  channel: NonNullable<ChatInputCommandInteraction["channel"]>,
  text: string,
  onReply: () => void,
): Message {
  return {
    id: i.id,
    content: text,
    author: i.user,
    channel,
    channelId: i.channelId,
    guild: i.guild,
    guildId: i.guildId,
    attachments: new Collection(),
    inGuild: () => i.inGuild(),
    // A slash command is explicit: it counts as a mention of the bot.
    mentions: { has: () => true },
    reply: async (o: { content: string }) => {
      onReply();
      return i.editReply({ content: o.content, allowedMentions: SAFE_MENTIONS });
    },
    // A conversation started in a plain channel gets its thread directly (no source message to attach to).
    startThread: (o: { name: string }) =>
      "threads" in channel
        ? channel.threads.create({ name: o.name })
        : Promise.reject(new Error("no threads")),
  } as unknown as Message;
}

/** Build the `interactionCreate` listener for slash commands (other interaction kinds are ignored). */
export function createSlashHandler(deps: {
  ownerId: string;
  onMessage: (msg: Message) => Promise<void>;
}) {
  return async function handleSlash(i: { isChatInputCommand(): boolean }): Promise<void> {
    if (!i.isChatInputCommand()) return;
    const cmd = i as ChatInputCommandInteraction;
    try {
      const text = slashText(cmd.commandName, (n) => {
        const o = cmd.options.get(n, false);
        return o?.value ?? null;
      });
      if (text === null) return;
      // Same owner rule as a message; strangers get a private refusal (a message is silently ignored).
      if (cmd.user.id !== deps.ownerId) {
        logEvent(log, "slash.refused", { reason: "not_owner" }, "debug");
        await cmd.reply({ content: "Not allowed.", flags: MessageFlags.Ephemeral });
        return;
      }
      // The channel is not cached (rare): the message path cannot run without it.
      const channel = cmd.channel;
      if (!channel) {
        await cmd.reply({ content: "Channel unavailable.", flags: MessageFlags.Ephemeral });
        return;
      }
      await cmd.deferReply();
      let replied = false;
      await deps.onMessage(asMessage(cmd, channel, text, () => (replied = true)));
      // The handler posts its answer in the channel/thread; drop the placeholder unless it was used for a reply.
      if (!replied) await cmd.deleteReply();
    } catch (err) {
      log.error({ err: errText(err) }, "slash handling failed");
      await cmd.editReply("Something went wrong. Check the logs.").catch(() => undefined);
    }
  };
}
