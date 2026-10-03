import type { Message, SendableChannels } from "discord.js";
import { logger } from "../observability/logger";
import { redactText } from "../observability/redact";
import {
  isStop,
  prepareReply,
  routeMessage,
  SAFE_MENTIONS,
  threadName,
} from "./discord-message-rules";
import type { Task } from "./task-types";

/** Typing indicator lasts ~10s on Discord; refresh a bit earlier. */
const TYPING_REFRESH_MS = 8000;

/** What the handler needs from the task layer. */
export type HandleTask = (task: Task) => Promise<string>;

/** Send a (possibly long) reply as redacted, chunked, non-pinging messages. */
async function sendReply(channel: SendableChannels, text: string): Promise<void> {
  for (const chunk of prepareReply(text))
    await channel.send({ content: chunk, allowedMentions: SAFE_MENTIONS });
}

/** Show the typing indicator until the returned stop function is called. */
function startTyping(channel: SendableChannels): () => void {
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
  handleTask: HandleTask;
}

/** Build the `messageCreate` handler: route, run the task, reply. Never throws. */
export function createMessageHandler(deps: MessageHandlerDeps) {
  const log = logger.child({ module: "discord-message-handler" });

  /** Run the task with typing shown, then post the reply into `channel`. */
  async function answer(channel: SendableChannels, threadId: string, text: string): Promise<void> {
    const stopTyping = startTyping(channel);
    try {
      const reply = await deps.handleTask({
        source: "discord",
        userId: deps.ownerId,
        threadId,
        text,
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
        inBotThread: ch.isThread() && ch.ownerId === botId,
        mentionsBot: msg.mentions.has(botId, { ignoreEveryone: true, ignoreRoles: true }),
        content: msg.content,
      },
      deps.ownerId,
      botId,
    );
    if (route.kind === "ignore") return;

    // Where error replies go: the thread once it exists, else the message's channel.
    let errorTarget: SendableChannels | null = ch.isSendable() ? ch : null;
    try {
      if (route.kind === "thread") {
        if (ch.isSendable()) await answer(ch, ch.id, route.prompt);
        return;
      }
      // `stop` only makes sense inside a thread that has a run.
      if (isStop(route.prompt)) {
        await msg.reply({
          content: "Send `stop` inside the thread of the run.",
          allowedMentions: SAFE_MENTIONS,
        });
        return;
      }
      const thread = await msg.startThread({ name: threadName(route.prompt) });
      errorTarget = thread;
      await answer(thread, thread.id, route.prompt);
    } catch (err) {
      // Full error to the log (redacted), short generic text to the user.
      log.error({ err: redactText(String(err)) }, "message handling failed");
      try {
        if (errorTarget) await sendReply(errorTarget, "Something went wrong. Check the logs.");
      } catch {
        /* channel unusable; already logged */
      }
    }
  };
}
