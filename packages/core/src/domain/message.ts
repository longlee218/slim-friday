import type { BotId } from "./bot";
import type { ConversationId } from "./conversation";

/** Who wrote a message. */
export type Author = { kind: "user" } | { kind: "bot"; botId: BotId } | { kind: "system" };

/** A message kept in a conversation. */
export interface StoredMessage {
  conversationId: ConversationId;
  author: Author;
  text: string;
  /** Epoch milliseconds. */
  at: number;
}
