import type { Message } from "discord.js";
import type { MemoryRunner, MemoryWhere } from "../memory/memory-command-handler";
import { sendReply } from "./discord-message-handler";

/**
 * Run `text` as an owner memory command and reply inline in the message's own channel or thread (no thread is
 * created, no task row, no agent). Returns false when the text is not a memory command (nothing was sent).
 * Owner and guild checks already ran in routing.
 */
export async function replyToMemoryCommand(
  runner: MemoryRunner,
  msg: Message,
  where: MemoryWhere,
  text: string,
): Promise<boolean> {
  const ch = msg.channel;
  const reply = await runner({
    where,
    // Routing key: threads never change parent, so the parent channel is the stable workspace key.
    channelId: ch.isThread() ? (ch.parentId ?? ch.id) : ch.id,
    threadId: ch.isThread() ? ch.id : undefined,
    text,
  });
  if (reply === null) return false;
  if (ch.isSendable()) await sendReply(ch, reply);
  return true;
}
