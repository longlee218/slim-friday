import type { Message, SendableChannels } from "discord.js";
import { type AttachmentDeps, withAttachments } from "../../../ingress/attachment-text";
import type { InboundMessage } from "../../../ingress/inbound-message";
import { createMessageReceipt } from "../../../ingress/message-receipt";
import { recentFor } from "../../../ingress/thread-history";
import { threadOnlyNote } from "../../../ingress/thread-only-commands";
import { createThreadTurns } from "../../../ingress/thread-turns";
import type { ThreadsPort } from "../../../ingress/threads-port";
import { languageOf, pinnedThreadLanguage, renderUserNotice } from "../../../ingress/user-copy";
import type { InlineRunner } from "../../../memory/find-command-handler";
import { excerpt, logEvent, logger } from "../../../observability/logger";
import { errText } from "../../../observability/redact";
import { type DiscordSetup, EMPTY_SETUP, opsIds } from "../setup/discord-setup-config";
import { replyText } from "../ui/send/reply-port";
import { BUSY_ACK_EMOJI, sendReply } from "../ui/send/send-port";
import { answerTurn } from "./answer-turn";
import type { ChannelAdopter } from "./channel-adoption";
import { routeMessage } from "./discord-message-rules";
import { replyToInlineCommand } from "./inline-command-ingress";
import { adoptRoute, openThread, threadFacts } from "./thread-placement";

export type { InboundMessage } from "../../../ingress/inbound-message";

export { FETCH_RECENT_TIMEOUT_MS } from "../../../ingress/thread-history";
/** What the handler needs from the orchestrator. */
export type HandleMessage = (message: InboundMessage) => Promise<string | undefined>;

export { sendReply } from "../ui/send/send-port";

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
  /** Inline owner commands (`/find`): answered before any thread or task is created. */
  inline?: InlineRunner;
  /** Ports of the attachment reader (summary, saved copy, fetch); tests inject fakes. */
  attachments?: AttachmentDeps;
  /** Thread persistence and channel lookup (placeholder rows, adoption). Absent: no rows, no adoption. */
  threads?: ThreadsPort;
  /** Auto-adopt of an owner-made channel on its first @mention (replies on its own). Absent: no adoption. */
  adoptChannel?: ChannelAdopter;
  /** Delay (ms) before a still-unanswered message gets the receipt reaction; default 2000 (tests shorten it). */
  receiptDelayMs?: number;
}

/** Build the `messageCreate` handler: route, run the turn, reply. Never throws. */
export function createMessageHandler(deps: MessageHandlerDeps) {
  const log = logger.child({ module: "discord-message-handler" });
  const setup = deps.setup ?? EMPTY_SETUP;
  const ops = opsIds(setup);
  const takeTurn = createThreadTurns(); // per-thread arrival order up to the `handleMessage` call

  return async function onMessage(msg: Message): Promise<void> {
    const botId = deps.botId();
    if (!botId) return;
    const ch = msg.channel;
    const decided = routeMessage(
      {
        authorId: msg.author.id,
        authorIsBot: msg.author.bot,
        inGuild: msg.inGuild(),
        otherGuild: !!deps.guildId && msg.guildId !== deps.guildId,
        ...threadFacts(ch, botId, ops, deps.threads, msg, deps.ownerId, !!msg.guildId),
        mentionsBot: msg.mentions.has(botId, { ignoreEveryone: true, ignoreRoles: true }),
        content: msg.content,
        hasAttachments: (msg.attachments?.size ?? 0) > 0,
        opsChannel: ops.has(ch.id) || (ch.isThread() && !!ch.parentId && ops.has(ch.parentId)),
        controlChannel: !ch.isThread() && setup.controlChannels.includes(ch.id),
      },
      deps.ownerId,
      botId,
    );
    // An adoptable thread persists its adoption here and continues as a normal `thread` turn.
    const route =
      decided.kind === "adopt" && ch.isThread() && ch.parentId
        ? adoptRoute(decided, ch.id, ch.parentId, deps.threads)
        : decided;
    if (route.kind === "ignore") {
      // Strangers' and bots' messages are noise (debug); the owner's ignored ones are worth seeing.
      const stranger = route.reason === "bot" || route.reason === "not_owner";
      logEvent(log, "message.ignored", { reason: route.reason }, stranger ? "debug" : "info");
      return;
    }
    if (route.kind === "control") {
      await Promise.resolve() // .then keeps a sync throw from `admin` inside the catch
        .then(() => deps.admin?.(msg, route.prompt))
        .catch((err) => log.error({ err: errText(err) }, "admin handling failed"));
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
      // Inline commands never reach the agent: answered in place (thread or channel), no thread, no task row.
      if (
        deps.inline &&
        (await replyToInlineCommand(deps.inline, msg, route.prompt, receipt.visible))
      )
        return;
      // Text attachments (a message > 2000 chars arrives as message.txt) join the agent's text as a DATA block.
      const key = route.kind === "thread" ? ch.id : msg.id; // a thread started from a message has its id
      const text = await withAttachments(msg.attachments, route.prompt, key, deps.attachments);
      if (route.kind === "thread") {
        // The thread's last messages give the lead the conversation (a new thread has none yet).
        if (ch.isSendable() && channelId)
          await answerTurn(
            deps,
            ch,
            {
              threadId: ch.id,
              channelId,
              messageId: msg.id,
              ...(msg.reference?.messageId && { replyToMessageId: msg.reference.messageId }),
            },
            receipt,
            text,
            await recentFor(ch, msg.id, { ownerId: deps.ownerId, botId }, text),
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
      // `/stop` and `/status` only make sense inside a thread that has a run.
      const threadOnly = threadOnlyNote(route.prompt);
      if (threadOnly) {
        await replyText(msg, renderUserNotice(threadOnly, languageOf(route.prompt)));
        await receipt.visible();
        return;
      }
      if ((await deps.adoptChannel?.(msg, receipt.visible)) === "refused") return; // owner got the reason; no thread
      const thread = await openThread(msg, ch.id, deps.threads);
      errorTarget = thread;
      await answerTurn(
        deps,
        thread,
        { threadId: thread.id, channelId: ch.id, messageId: msg.id },
        receipt,
        text,
        undefined,
        undefined,
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
