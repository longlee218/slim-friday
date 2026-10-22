import {
  type BaseMessageOptions,
  type InteractionReplyOptions,
  type Message,
  type MessageEditOptions,
  MessageFlags,
  type SendableChannels,
} from "discord.js";
import { SAFE_MENTIONS } from "../../ingress/discord-message-rules";

/*
 * The only place (with `send-port.ts`) that calls Discord's send / reply / edit methods. Text helpers add the mention
 * policy (nothing can ping); a test (`provider-send-scan.test.ts`) keeps raw calls out of every other file.
 */

/** The slice of an interaction `replyEphemeral` and `editReplyText` need (tests pass fakes). */
interface Repliable {
  reply(o: InteractionReplyOptions): Promise<unknown>;
}
interface EditReplyable {
  editReply(o: { content: string; allowedMentions: typeof SAFE_MENTIONS }): Promise<unknown>;
}
interface Deferrable {
  deferReply(): Promise<unknown>;
  deleteReply(): Promise<unknown>;
}
interface Updatable {
  update(o: MessageEditOptions): Promise<unknown>;
}

/** A reply only the user who triggered the interaction sees; `files` ride along (a long answer). */
export const replyEphemeral = (
  i: Repliable,
  content: string,
  files?: BaseMessageOptions["files"],
) =>
  i.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: SAFE_MENTIONS,
    ...(files && { files }),
  });

/** Fill in a deferred interaction reply with plain text. */
export const editReplyText = (i: EditReplyable, content: string) =>
  i.editReply({ content, allowedMentions: SAFE_MENTIONS });

/** Reply to a message with plain text (no ping). */
export const replyText = (msg: Pick<Message, "reply">, content: string) =>
  msg.reply({ content, allowedMentions: SAFE_MENTIONS });

/** Post plain text into a channel or thread (no ping). */
export const sendText = (channel: Pick<SendableChannels, "send">, content: string) =>
  channel.send({ content, allowedMentions: SAFE_MENTIONS });

/** Post a prepared payload (a components-v2 message built by `ui/messages`). */
export const sendMessage = (
  channel: Pick<SendableChannels, "send">,
  payload: Parameters<SendableChannels["send"]>[0],
) => channel.send(payload);

/** Edit a message the bot posted (settle a question). */
export const editMessage = (msg: Pick<Message, "edit">, payload: MessageEditOptions) =>
  msg.edit(payload);

/** Answer a button / select click by replacing its message (the 3 s acknowledgement). */
export const updateMessage = (i: Updatable, payload: MessageEditOptions) => i.update(payload);

/** Acknowledge an interaction now (the 3 s deadline) and answer later with `editReplyText`. */
export const deferReply = (i: Pick<Deferrable, "deferReply">) => i.deferReply();

/** Remove a deferred reply nobody filled in. */
export const deleteReply = (i: Pick<Deferrable, "deleteReply">) => i.deleteReply();
