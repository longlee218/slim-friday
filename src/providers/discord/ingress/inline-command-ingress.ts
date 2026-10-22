import type { Message } from "discord.js";
import { languageOf } from "../../../ingress/user-copy";
import type { InlineRunner } from "../../../memory/find-command-handler";
import { sendReply } from "./discord-message-handler";

/**
 * Run `text` as an inline owner command (`/find`) and reply in the message's own channel or thread (no thread is
 * created, no task row, no agent). Returns false when the text is not an inline command (nothing was sent).
 * Owner and guild checks already ran in routing.
 */
export async function replyToInlineCommand(
  runner: InlineRunner,
  msg: Message,
  text: string,
  visible?: () => Promise<void>,
): Promise<boolean> {
  const ch = msg.channel;
  const reply = await runner({
    // Routing key: threads never change parent, so the parent channel is the stable workspace key.
    channelId: ch.isThread() ? (ch.parentId ?? ch.id) : ch.id,
    text,
  });
  if (reply === null) return false;
  if (ch.isSendable()) await sendReply(ch, reply, languageOf(text), visible);
  return true;
}
