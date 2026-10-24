import type { BotId, GroupId } from "@friday/core";
import type { IncomingAttachment } from "./download-attachments";

/** What a Discord channel stands for. */
export type ChannelTarget = { kind: "bot"; botId: BotId } | { kind: "group"; groupId: GroupId };

/** A message seen in a channel. */
export interface IncomingMessage {
  channelId: string;
  authorId: string;
  /** Written by a bot account or a webhook (including this app's own posts). */
  fromBotOrWebhook: boolean;
  text: string;
  /** Files on the message (not downloaded yet). */
  attachments?: IncomingAttachment[];
}

/** A button click. */
export interface IncomingClick {
  channelId: string;
  userId: string;
  customId: string;
  /** Acknowledge the click (stops the Discord spinner). */
  ack(): Promise<void>;
}

/** A slash command. */
export interface IncomingCommand {
  channelId: string;
  userId: string;
  name: "stop" | "status" | "purge" | "tickets";
  /** The optional `bot` argument of `/stop`. */
  botName?: string;
  /** Reply that only the caller sees. */
  reply(text: string): Promise<void>;
}

/** A channel of the guild. */
export interface ChannelInfo {
  id: string;
  name: string;
  topic?: string;
  parentId?: string;
}

/** A button on a message. */
export interface ButtonSpec {
  id: string;
  label: string;
  style: "primary" | "secondary" | "danger";
}

/** Everything the surface needs from Discord; the discord.js adapter implements it, tests use a fake. */
export interface DiscordPort {
  /** The only user whose messages and clicks count. */
  ownerId: string;
  onMessage(h: (m: IncomingMessage) => void): void;
  onClick(h: (c: IncomingClick) => void): void;
  onCommand(h: (c: IncomingCommand) => void): void;
  /** Post as the app itself. */
  send(channelId: string, text: string): Promise<void>;
  /** Post under another display name (a webhook); `avatar` is a PNG file the webhook shows as its picture. */
  sendAs(channelId: string, username: string, text: string, avatar?: string): Promise<void>;
  /** Post a file under another display name (a webhook), with an optional caption. */
  sendFileAs(
    channelId: string,
    username: string,
    file: { path: string; name: string },
    caption?: string,
    avatar?: string,
  ): Promise<void>;
  typing(channelId: string): Promise<void>;
  /** Post text with buttons; returns the message id. */
  sendButtons(channelId: string, text: string, buttons: ButtonSpec[]): Promise<string>;
  /** Replace a message's text and drop its buttons. */
  editMessage(channelId: string, messageId: string, text: string): Promise<void>;
  listChannels(): Promise<ChannelInfo[]>;
  createCategory(name: string): Promise<string>;
  /** A text channel only the owner and the app can see; returns its id. */
  createPrivateChannel(name: string, parentId: string, topic: string): Promise<string>;
}
