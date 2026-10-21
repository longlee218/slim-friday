import type { SendableChannels } from "discord.js";
import type { HandleMessage } from "./discord-message-handler";
import { sendReply, sendResultFile, startTyping } from "./discord-send";
import type { RecentMessage } from "./intent-types";
import type { createMessageReceipt } from "./message-receipt";
import { detectLanguage, languageOf, pinnedThreadLanguage, pinThreadLanguage } from "./user-copy";

/** What one answered turn needs from the handler. */
export interface AnswerDeps {
  ownerId: string;
  botId: () => string | undefined;
  handleMessage: HandleMessage;
}

/**
 * Run the turn with typing shown, then post the reply into `channel`.
 * `started` runs right after the `handleMessage` call began.
 */
export async function answerTurn(
  deps: AnswerDeps,
  channel: SendableChannels,
  ids: { threadId: string; channelId: string; messageId: string; replyToMessageId?: string },
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
  /** After the first visible message, typing restarts for the next composing phase. */
  const retype = () => {
    if (!shown) return;
    stopTyping();
    stopTyping = startTyping(channel);
  };
  const visible = async () => {
    shown = true;
    stopTyping();
    await receipt.visible();
  };
  try {
    const call = deps.handleMessage({
      source: "discord",
      userId: deps.ownerId,
      ...ids,
      text,
      ...(recent?.length && { recent }),
      language,
      visible,
      notify: (m, opts) => {
        retype();
        // A caught send failure ends this composing phase too; background work must not refresh typing.
        const stopNotificationTyping = stopTyping;
        const sent = opts?.asFile
          ? sendResultFile(channel, m, language, visible, opts.fileName, opts.links)
          : sendReply(channel, m, language, visible);
        return sent.finally(stopNotificationTyping);
      },
    });
    started?.();
    const reply = await call;
    if (reply === undefined) return; // nothing to send here: the lead answers on its own through `notify`
    retype();
    await sendReply(channel, reply, language, visible);
  } finally {
    stopTyping();
  }
}
