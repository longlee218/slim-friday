import { AttachmentBuilder, type Message, type SendableChannels } from "discord.js";
import { type DiscordSetup, EMPTY_SETUP, opsIds } from "../discord-setup/discord-setup-config";
import type { MemoryRunner } from "../memory/memory-command-handler";
import { excerpt, logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { parseTaskCommand } from "../orchestrator/task-commands";
import {
  prepareOutput,
  routeMessage,
  SAFE_MENTIONS,
  stripMention,
  threadName,
} from "./discord-message-rules";
import { replyToMemoryCommand } from "./memory-ingress";

/** A unit of work arriving from any ingress (Discord, tests). */
export interface Task {
  /** Where it came from, e.g. "discord". */
  source: string;
  /** Sender id; ingress enforces the owner allowlist. */
  userId: string;
  /** Conversation thread; maps 1:1 to a Claude session. */
  threadId: string;
  /** Routing key: the parent channel of the thread (or the channel of a new conversation). */
  channelId: string;
  text: string;
  /** Posts a message into the thread while the task still runs (a dispatched plan waits for approval). */
  notify?: (text: string) => Promise<void>;
}

/** Typing indicator lasts ~10s on Discord; refresh a bit earlier. */
const TYPING_REFRESH_MS = 8000;

/** What the handler needs from the task layer. */
export type HandleTask = (task: Task) => Promise<string>;

/** Send a (possibly long) reply as redacted, chunked, non-pinging messages; a very long one or a diff as head + file. */
export async function sendReply(channel: SendableChannels, text: string): Promise<void> {
  const { chunks, file } = prepareOutput(text);
  for (const [i, chunk] of chunks.entries()) {
    const files =
      file && i === chunks.length - 1
        ? [new AttachmentBuilder(Buffer.from(file.content), { name: file.name })]
        : [];
    await channel.send({ content: chunk, files, allowedMentions: SAFE_MENTIONS });
  }
}

/** Show the typing indicator until the returned stop function is called. */
export function startTyping(channel: SendableChannels): () => void {
  const ping = () => {
    channel.sendTyping().catch(() => {});
  };
  ping();
  const timer = setInterval(ping, TYPING_REFRESH_MS);
  return () => clearInterval(timer);
}

/** Inputs of the message handler (injectable for tests). */
export interface MessageHandlerDeps {
  /** Owner's Discord user id; all other authors are ignored. */
  ownerId: string;
  /** Id of the logged-in bot user (undefined before login). */
  botId: () => string | undefined;
  /** The one guild the bot serves; messages from any other guild are ignored (undefined: no pin). */
  guildId?: string;
  handleTask: HandleTask;
  /** discord.yaml: ops channels never reach `handleTask`; control channels run admin commands. Default: none. */
  setup?: DiscordSetup;
  /** Admin handling for messages routed as `control` (gate + commands); never the agent. */
  admin?: (msg: Message, prompt: string) => Promise<void>;
  /** Owner memory commands (`remember:` ...): answered inline before any thread or task is created. */
  memory?: MemoryRunner;
}

/** Build the `messageCreate` handler: route, run the task, reply. Never throws. */
export function createMessageHandler(deps: MessageHandlerDeps) {
  const log = logger.child({ module: "discord-message-handler" });
  const setup = deps.setup ?? EMPTY_SETUP;
  const ops = opsIds(setup);

  /** Run the task with typing shown, then post the reply into `channel`. */
  async function answer(
    channel: SendableChannels,
    ids: { threadId: string; channelId: string },
    text: string,
  ): Promise<void> {
    const stopTyping = startTyping(channel);
    try {
      const reply = await deps.handleTask({
        source: "discord",
        userId: deps.ownerId,
        ...ids,
        text,
        notify: (m) => sendReply(channel, m),
      });
      await sendReply(channel, reply);
    } finally {
      stopTyping();
    }
  }

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
    try {
      // Memory commands never reach the agent: answered in place (thread or channel), no thread, no task row.
      if (deps.memory && (await replyToMemoryCommand(deps.memory, msg, "workspace", route.prompt)))
        return;
      if (route.kind === "thread") {
        if (ch.isSendable() && channelId)
          await answer(ch, { threadId: ch.id, channelId }, route.prompt);
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
      if (parseTaskCommand(route.prompt).kind === "stop") {
        await msg.reply({
          content: "Send `stop` inside the thread of the run.",
          allowedMentions: SAFE_MENTIONS,
        });
        return;
      }
      const thread = await msg.startThread({ name: threadName(route.prompt) });
      errorTarget = thread;
      await answer(thread, { threadId: thread.id, channelId: ch.id }, route.prompt);
    } catch (err) {
      // Full error to the log (redacted), short generic text to the user.
      log.error({ err: errText(err) }, "message handling failed");
      try {
        if (errorTarget) await sendReply(errorTarget, "Something went wrong. Check the logs.");
      } catch {
        /* channel unusable; already logged */
      }
    }
  };
}
