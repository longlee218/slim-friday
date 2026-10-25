import type { BotId } from "./bot";
import type { ConversationId } from "./conversation";
import type { RunStep } from "./run";

/** Who wrote a message. */
/** A file the user sent, already saved on disk. */
export interface Attachment {
  /** Safe file name (`<n>-<sanitised name>`). */
  name: string;
  mimeType: string;
  /** Absolute path of the saved copy. */
  path: string;
  size: number;
}

export type Author = { kind: "user" } | { kind: "bot"; botId: BotId } | { kind: "system" };

/** How a message is shown: plain text, a file card, a bot-to-bot relay, or a progress update of a running turn. */
export type MessageKind = "text" | "file" | "relay" | "progress";

/** A stored file (an R2 object) attached to a message. */
export interface FileRef {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  /** Pixel size, set for images only. */
  width?: number;
  height?: number;
}

/** A bot-to-bot hand-off shown in the conversation. */
export interface RelayInfo {
  fromBotId: BotId;
  toBotId: BotId;
  intent: "request" | "handoff" | "result";
  state?: string;
}

/** A message kept in a conversation. */
export interface StoredMessage {
  conversationId: ConversationId;
  author: Author;
  text: string;
  /** Epoch milliseconds. */
  at: number;
  /** Default "text". */
  kind?: MessageKind;
  /** Id of the message this one replies to. */
  replyTo?: number;
  files?: FileRef[];
  /** Steps of the turn that produced this bot message. */
  run?: RunStep[];
  relay?: RelayInfo;
  /** The wake (run) that produced this message; lets progress messages be counted per run. */
  wakeId?: string;
  /** The schedule whose run posted this message (kept after the schedule and its wake are gone). */
  scheduleId?: string;
  /** That schedule's name when its run started; unset when the schedule was already gone. */
  scheduleName?: string;
}

/** A stored message with its row id (ids grow with time). */
export type IndexedMessage = StoredMessage & { id: number };
