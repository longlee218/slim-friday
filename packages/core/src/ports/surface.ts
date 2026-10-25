import type { BotId } from "../domain/bot";
import type { CardRow } from "../domain/card";
import type { ConversationId } from "../domain/conversation";
import type { Attachment, Author, FileRef, IndexedMessage } from "../domain/message";
import type { RunStep } from "../domain/run";

/** A message from the user, as the surface delivers it. */
export interface InboundMessage {
  conversationId: ConversationId;
  text: string;
  /** Files the user attached, already saved. */
  attachments?: Attachment[];
  /** Id of the message this one replies to. */
  replyTo?: number;
  /** The stored copies of the attachments. */
  files?: FileRef[];
  /** Set by the client per send: a resend with the same nonce stores nothing new, returns the first id and routes it again (idempotent). */
  clientNonce?: string;
}

/** A message the surface shows: the stored row with its id. */
export type OutboundMessage = IndexedMessage;

export type ApprovalAnswer = "once" | "always" | "deny";

/** A live status shown next to the conversation. */
export interface Activity {
  kind: "typing" | "subagent";
  botId: BotId;
  label?: string;
}

/** Where the user talks to the bots (chat app, web app). */
export interface Surface {
  /** The handler resolves with the stored id of the owner's message (undefined: nothing stored). */
  onMessage(handler: (m: InboundMessage) => Promise<number | undefined>): void;
  post(conversationId: ConversationId, m: OutboundMessage): Promise<void>;
  /**
   * Show a stored approval or question card (written first, so a restart shows it again); `botName` is the
   * asking bot's display name. The answer comes back through the hub's `answerCard`, never as a return value.
   */
  showCard(card: CardRow, botName: string): void;
  /** The card was answered or withdrawn (`card` holds its new status and answer): close it on the surface. */
  closeCard(card: CardRow): void;
  showActivity(conversationId: ConversationId, a: Activity): void;
  /** Show one step of the bot's run in progress. */
  showRun(conversationId: ConversationId, botId: BotId, step: RunStep): void;
  /**
   * A run posted its final answer to the owner: tell the surface (live only, never stored). `preview` is the
   * final text (secrets redacted) cut to 180 chars. Never called for silent, ticket, intro or bot-only runs.
   */
  notifyFinished(e: { conversationId: ConversationId; botId: BotId; preview: string }): void;
  /** Send a file (already checked by the caller) under the author's name, with an optional caption. */
  postFile(
    conversationId: ConversationId,
    author: Author,
    file: { path: string; name: string },
    caption?: string,
  ): Promise<void>;
}
