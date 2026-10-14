import type { Client, Message } from "discord.js";
import { logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { STEER_DONE_EMOJI } from "./discord-send";

/** Reaction put on an owner message once the agent has READ it (the SDK replayed the steer): the quiet delivered receipt. */
// Not 👀: that is the busy receipt (`BUSY_ACK_EMOJI`), removed by the receipt on the same message. Owner may change it.
export const STEER_READ_EMOJI = "📖";

/**
 * Reacts on an owner message for the orchestrator (the agent never holds a Discord token; only this app-side port does).
 * Best effort: returns whether the reaction was added, never throws.
 */
export interface MessageReactionPort {
  react(threadId: string, messageId: string, emoji: string): Promise<boolean>;
}

const log = logger.child({ module: "message-reaction" });

/** Build the port over a lazily-read client (the client is created after the turn handler). */
export function createMessageReactionPort(
  getClient: () => Client | undefined,
): MessageReactionPort {
  return {
    async react(threadId, messageId, emoji) {
      try {
        const ch = await getClient()?.channels.fetch(threadId);
        if (!ch?.isTextBased()) return false;
        await (await ch.messages.fetch(messageId)).react(emoji);
        return true;
      } catch (err) {
        log.warn({ err: errText(err), threadId }, "message reaction failed");
        return false;
      }
    },
  };
}

/**
 * The done reaction for a repeated steer notice, as a callback safe on any `Message`: a slash interaction's stand-in
 * message has no `react`, so it resolves to nothing instead of throwing.
 */
export const reactDoneOf =
  (msg: Message): (() => Promise<unknown>) =>
  async () =>
    msg.react?.(STEER_DONE_EMOJI);
