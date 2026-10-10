import { AttachmentBuilder, type SendableChannels } from "discord.js";
import { prepareOutput, SAFE_MENTIONS } from "./discord-message-rules";

/** Typing indicator lasts ~10s on Discord; refresh a bit earlier. */
const TYPING_REFRESH_MS = 8000;

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
