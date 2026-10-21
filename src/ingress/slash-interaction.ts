import {
  AttachmentBuilder,
  type ChatInputCommandInteraction,
  type Client,
  Collection,
  type Message,
  MessageFlags,
} from "discord.js";
import { PLAN_HISTORY_ARG, parseSlash } from "../commands/slash-commands";
import { slashPayload, slashText } from "../commands/slash-definitions";
import { DEFAULT_LANGUAGE } from "../i18n/languages";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { CHUNK_MAX, SAFE_MENTIONS } from "./discord-message-rules";
import type { LimitsText, LimitsView } from "./limits-copy";
import { type PlanLookup, renderPlanFacts } from "./plan-copy";
import {
  languageOf,
  type OwnerLanguage,
  pinnedThreadLanguage,
  renderUserNotice,
} from "./user-copy";

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

/**
 * `/limits`: a private (ephemeral) reply. A text over one Discord message goes out as the file `limits.md`, with the
 * head (pools + live state) as the message body.
 */
async function replyLimits(i: ChatInputCommandInteraction, r: LimitsText): Promise<void> {
  if (r.text.length <= CHUNK_MAX) {
    await i.reply({
      content: r.text,
      flags: MessageFlags.Ephemeral,
      allowedMentions: SAFE_MENTIONS,
    });
    return;
  }
  await i.reply({
    content: r.head.slice(0, CHUNK_MAX),
    files: [new AttachmentBuilder(Buffer.from(r.text), { name: "limits.md" })],
    flags: MessageFlags.Ephemeral,
    allowedMentions: SAFE_MENTIONS,
  });
}

/** Build the `interactionCreate` listener for slash commands (other interaction kinds are ignored). */
export function createSlashHandler(deps: {
  ownerId: string;
  onMessage: (msg: Message) => Promise<void>;
  /** Builds the `/limits` text (app code, no model); without it `/limits` is not handled here. */
  limits?: LimitsView;
  /** Builds the `/plan` facts of a thread (app code, no model); without it `/plan` is not handled here. */
  plan?: PlanLookup;
}) {
  return async function handleSlash(i: { isChatInputCommand(): boolean }): Promise<void> {
    if (!i.isChatInputCommand()) return;
    const cmd = i as ChatInputCommandInteraction;
    let language: OwnerLanguage = DEFAULT_LANGUAGE; // refined from the command text once it is known
    try {
      const text = slashText(cmd.commandName, (n) => {
        const o = cmd.options.get(n, false);
        return o?.value ?? null;
      });
      if (text === null) return;
      language = languageOf(text);
      // Same owner rule as a message; strangers get a private refusal (a message is silently ignored).
      if (cmd.user.id !== deps.ownerId) {
        logEvent(log, "slash.refused", { reason: "not_owner" }, "debug");
        await cmd.reply({
          content: renderUserNotice({ kind: "note", state: "not-allowed" }, language),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // `/limits` needs no thread or channel: answered privately by app code, before the message path.
      const parsed = parseSlash(text);
      if (parsed?.name === "limits" && deps.limits) {
        try {
          await replyLimits(cmd, await deps.limits(parsed.arg || undefined, language));
        } catch (err) {
          // Nothing was replied yet (the view is built before the one reply): a short private notice, never a thrown error.
          log.error({ err: errText(err) }, "limits reply failed");
          await cmd
            .reply({
              content: renderUserNotice({ kind: "failure" }, language),
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => undefined);
        }
        return;
      }
      // `/plan` is about the thread it is typed in: answered privately by app code, no message path.
      if (parsed?.name === "plan" && deps.plan) {
        try {
          const history = parsed.arg.toLowerCase() === PLAN_HISTORY_ARG;
          // The thread's language when known (as for other owner notices); the slash text is the fallback.
          const planLanguage = pinnedThreadLanguage(cmd.channelId) ?? language;
          await cmd.reply({
            content: renderPlanFacts(deps.plan(cmd.channelId, history), planLanguage),
            flags: MessageFlags.Ephemeral,
            allowedMentions: SAFE_MENTIONS,
          });
        } catch (err) {
          log.error({ err: errText(err) }, "plan reply failed");
          await cmd
            .reply({
              content: renderUserNotice({ kind: "failure" }, language),
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => undefined);
        }
        return;
      }
      // The channel is not cached (rare): the message path cannot run without it.
      const channel = cmd.channel;
      if (!channel) {
        await cmd.reply({
          content: renderUserNotice({ kind: "note", state: "channel-unavailable" }, language),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await cmd.deferReply();
      let replied = false;
      await deps.onMessage(asMessage(cmd, channel, text, () => (replied = true)));
      // The handler posts its answer in the channel/thread; drop the placeholder unless it was used for a reply.
      if (!replied) await cmd.deleteReply();
    } catch (err) {
      log.error({ err: errText(err) }, "slash handling failed");
      await cmd.editReply(renderUserNotice({ kind: "failure" }, language)).catch(() => undefined);
    }
  };
}
