import type { Message, SendableChannels } from "discord.js";
import { type DiscordSetup, EMPTY_SETUP, opsIds } from "../discord-setup/discord-setup-config";
import type { RecentMessage } from "../intent/intent-types";
import type { MemoryRunner } from "../memory/memory-command-handler";
import { excerpt, logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { parseMessageCommand } from "../orchestrator/message-commands";
import { type AttachmentDeps, withAttachments } from "./attachment-text";
import { routeMessage, SAFE_MENTIONS, stripMention, threadName } from "./discord-message-rules";
import { BUSY_ACK_EMOJI, sendReply, startTyping } from "./discord-send";
import type { InboundMessage } from "./inbound-message";
import { replyToMemoryCommand } from "./memory-ingress";
import { createMessageReceipt } from "./message-receipt";
import { fetchRecent, HISTORY_CHARS, type HistoryChannel } from "./thread-history";
import { createThreadTurns } from "./thread-turns";
import {
  detectLanguage,
  languageOf,
  pinnedThreadLanguage,
  pinThreadLanguage,
  renderUserNotice,
} from "./user-copy";

export type { InboundMessage } from "./inbound-message";

/** Longest wait (ms) for the thread history; the message then goes on without it. */
export const FETCH_RECENT_TIMEOUT_MS = 1500;
/** What the handler needs from the orchestrator. */
export type HandleMessage = (message: InboundMessage) => Promise<string>;

export { sendReply, startTyping } from "./discord-send";

/** Inputs of the message handler (injectable for tests). */
export interface MessageHandlerDeps {
  /** Owner's Discord user id; all other authors are ignored. */
  ownerId: string;
  /** Id of the logged-in bot user (undefined before login). */
  botId: () => string | undefined;
  /** The one guild the bot serves; messages from any other guild are ignored (undefined: no pin). */
  guildId?: string;
  handleMessage: HandleMessage;
  /** discord.yaml: ops channels never reach `handleMessage`; control channels run admin commands. Default: none. */
  setup?: DiscordSetup;
  /** Admin handling for messages routed as `control` (gate + commands); never the agent. */
  admin?: (msg: Message, prompt: string) => Promise<void>;
  /** Owner memory commands (`forget:`, `compact memory`): answered inline before any thread or task is created. */
  memory?: MemoryRunner;
  /** Ports of the attachment reader (summary, saved copy, fetch); tests inject fakes. */
  attachments?: AttachmentDeps;
  /** Delay (ms) before a still-unanswered message gets the receipt reaction; default 2000 (tests shorten it). */
  receiptDelayMs?: number;
}

/** Build the `messageCreate` handler: route, run the turn, reply. Never throws. */
export function createMessageHandler(deps: MessageHandlerDeps) {
  const log = logger.child({ module: "discord-message-handler" });
  const setup = deps.setup ?? EMPTY_SETUP;
  const ops = opsIds(setup);
  const takeTurn = createThreadTurns(); // per-thread arrival order up to the `handleMessage` call

  /** Run the turn with typing shown, then post the reply into `channel`. `started` runs right after the `handleMessage` call began. */
  async function answer(
    channel: SendableChannels,
    ids: { threadId: string; channelId: string; messageId: string },
    receipt: ReturnType<typeof createMessageReceipt>,
    text: string,
    recent?: RecentMessage[],
    started?: () => void,
  ): Promise<void> {
    // The text decides; neutral text ("3", "yes") keeps the thread's language, else the recent owner messages.
    const language =
      detectLanguage(text) ?? pinnedThreadLanguage(ids.threadId) ?? languageOf(text, recent);
    pinThreadLanguage(ids.threadId, language);
    let stopTyping = startTyping(channel);
    let shown = false;
    const visible = async () => {
      shown = true;
      stopTyping();
      await receipt.visible();
    };
    // Resolved once the reply is out: the thread's rollover work (flush, summary) starts only then.
    let posted!: () => void;
    const replied = new Promise<void>((r) => {
      posted = r;
    });
    try {
      const call = deps.handleMessage({
        source: "discord",
        userId: deps.ownerId,
        ...ids,
        text,
        ...(recent?.length && { recent }),
        language,
        visible,
        replied,
        history: (limit) => historyOf(channel as unknown as HistoryChannel, limit),
        notify: (m) => {
          if (shown) {
            stopTyping();
            stopTyping = startTyping(channel);
          }
          // A caught send failure ends this composing phase too; background work must not refresh typing.
          const stopNotificationTyping = stopTyping;
          return sendReply(channel, m, language, visible).finally(stopNotificationTyping);
        },
      });
      started?.();
      const reply = await call;
      if (shown) {
        stopTyping();
        stopTyping = startTyping(channel);
      }
      await sendReply(channel, reply, language, visible);
    } finally {
      posted();
      stopTyping();
    }
  }

  /** The thread's last `limit` messages, whoever is current (nothing excluded); the bot's own reply included. */
  const historyOf = (ch: HistoryChannel, limit: number) => {
    const botId = deps.botId();
    return botId
      ? fetchRecent(ch, { currentId: "", ownerId: deps.ownerId, botId }, limit, HISTORY_CHARS)
      : Promise.resolve([]);
  };

  /**
   * The thread history for the intent layer. Skipped for commands (slash or legacy: `/stop` must be instant) and
   * raced against FETCH_RECENT_TIMEOUT_MS: a hang or an error is no history, the message still proceeds.
   */
  const recentFor = (
    ch: Parameters<typeof fetchRecent>[0],
    id: string,
    botId: string,
    text: string,
  ) =>
    parseMessageCommand(text).kind !== "message"
      ? []
      : Promise.race([
          fetchRecent(ch, { currentId: id, ownerId: deps.ownerId, botId }),
          new Promise<never[]>((r) => setTimeout(() => r([]), FETCH_RECENT_TIMEOUT_MS).unref()),
        ]);

  return async function onMessage(msg: Message): Promise<void> {
    const botId = deps.botId();
    if (!botId) return;
    const ch = msg.channel;
    const route = routeMessage(
      {
        authorId: msg.author.id,
        authorIsBot: msg.author.bot,
        inGuild: msg.inGuild(),
        otherGuild: !!deps.guildId && msg.guildId !== deps.guildId,
        inBotThread: ch.isThread() && ch.ownerId === botId,
        mentionsBot: msg.mentions.has(botId, { ignoreEveryone: true, ignoreRoles: true }),
        content: msg.content,
        hasAttachments: (msg.attachments?.size ?? 0) > 0,
        opsChannel: ops.has(ch.id) || (ch.isThread() && !!ch.parentId && ops.has(ch.parentId)),
        controlChannel: !ch.isThread() && setup.controlChannels.includes(ch.id),
      },
      deps.ownerId,
      botId,
    );
    if (route.kind === "ignore") {
      // Strangers' and bots' messages are noise (debug); the owner's ignored ones are worth seeing.
      const stranger = route.reason === "bot" || route.reason === "not_owner";
      logEvent(log, "message.ignored", { reason: route.reason }, stranger ? "debug" : "info");
      // A memory command in a non-control ops channel is refused with a reply (nothing is executed).
      if (route.reason === "ops_channel" && deps.memory)
        await replyToMemoryCommand(deps.memory, msg, "ops", stripMention(msg.content, botId)).catch(
          (err) => log.error({ err: errText(err) }, "memory refusal failed"),
        );
      return;
    }
    if (route.kind === "control") {
      try {
        await deps.admin?.(msg, route.prompt);
      } catch (err) {
        log.error({ err: errText(err) }, "admin handling failed");
      }
      return;
    }
    const receipt = createMessageReceipt(
      async () => {
        await msg.react(BUSY_ACK_EMOJI);
      },
      async () => {
        await msg.reactions.cache.get(BUSY_ACK_EMOJI)?.users.remove(botId);
      },
      deps.receiptDelayMs,
    );
    // Only the owner's text is logged (redacted, capped).
    logEvent(log, "message.received", {
      owner: true,
      where: route.kind, // "thread" (follow-up in a bot thread) or "channel" (new conversation)
      ...(route.kind === "thread" ? { threadId: ch.id } : { channelId: ch.id }),
      text: excerpt(route.prompt),
    });

    // Routing key: threads never change parent, so the parent channel is the stable workspace key.
    const channelId = ch.isThread() ? ch.parentId : ch.id;
    // Where error replies go: the thread once it exists, else the message's channel.
    let errorTarget: SendableChannels | null = ch.isSendable() ? ch : null;
    const turn = route.kind === "thread" ? takeTurn(ch.id) : undefined;
    try {
      await turn?.wait;
      // Memory commands never reach the agent: answered in place (thread or channel), no thread, no task row.
      if (
        deps.memory &&
        (await replyToMemoryCommand(deps.memory, msg, "workspace", route.prompt, receipt.visible))
      )
        return;
      // Text attachments (a message > 2000 chars arrives as message.txt) join the agent's text as a DATA block.
      const key = route.kind === "thread" ? ch.id : msg.id; // a thread started from a message has its id
      const text = await withAttachments(msg.attachments, route.prompt, key, deps.attachments);
      if (route.kind === "thread") {
        // The thread's last messages give the intent layer the conversation (a new thread has none yet).
        if (ch.isSendable() && channelId)
          await answer(
            ch,
            {
              threadId: ch.id,
              channelId,
              messageId: msg.id,
            },
            receipt,
            text,
            await recentFor(ch, msg.id, botId, text),
            turn?.done,
          );
        else
          logEvent(
            log,
            "message.ignored",
            { reason: "no_parent_channel", threadId: ch.id },
            "warn",
          );
        return;
      }
      // `stop` only makes sense inside a thread that has a run.
      if (parseMessageCommand(route.prompt).kind === "stop") {
        await msg.reply({
          content: renderUserNotice(
            { kind: "note", state: "stop-in-thread" },
            languageOf(route.prompt),
          ),
          allowedMentions: SAFE_MENTIONS,
        });
        await receipt.visible();
        return;
      }
      const thread = await msg.startThread({ name: threadName(route.prompt) });
      errorTarget = thread;
      await answer(
        thread,
        { threadId: thread.id, channelId: ch.id, messageId: msg.id },
        receipt,
        text,
      );
    } catch (err) {
      // Full error to the log (redacted), short generic text to the user.
      log.error({ err: errText(err) }, "message handling failed");
      try {
        if (errorTarget) {
          const language = pinnedThreadLanguage(errorTarget.id) ?? languageOf(route.prompt);
          await sendReply(
            errorTarget,
            renderUserNotice({ kind: "failure" }, language),
            language,
            receipt.visible,
          );
        }
      } catch {
        /* channel unusable; already logged */
      }
    } finally {
      receipt.dispose();
      turn?.done(); // never leave the next message waiting
    }
  };
}
