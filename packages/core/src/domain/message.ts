import type { BotId } from "./bot";
import type { ConversationId } from "./conversation";

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

/** A message kept in a conversation. */
export interface StoredMessage {
  conversationId: ConversationId;
  author: Author;
  text: string;
  /** Epoch milliseconds. */
  at: number;
}

/** A stored message with its row id (ids grow with time). */
export type IndexedMessage = StoredMessage & { id: number };
