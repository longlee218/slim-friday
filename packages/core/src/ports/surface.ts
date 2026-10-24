import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Attachment, Author, FileRef, IndexedMessage } from "../domain/message";
import type { QuestionAnswer, QuestionCard } from "../domain/question";
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
  /** Set by the client per send: a resend with the same nonce returns the first stored id and does nothing else. */
  clientNonce?: string;
}

/** A message the surface shows: the stored row with its id. */
export type OutboundMessage = IndexedMessage;

/** What the user is asked when a call needs approval. */
export interface ApprovalCard {
  /** The bot that asks; set by the permission gate. */
  botId?: BotId;
  botName: string;
  tool: string;
  summary: string;
  scope: Record<string, string>;
  /** Show the "Always allow" choice. */
  offerAlways: boolean;
  /** The surface closes the card after this long (the gate has denied by then). */
  timeoutMs?: number;
}

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
  askApproval(conversationId: ConversationId, card: ApprovalCard): Promise<ApprovalAnswer>;
  showActivity(conversationId: ConversationId, a: Activity): void;
  /** Ask the owner a bot's question; resolves `null` when nobody answers in time. */
  askQuestion(conversationId: ConversationId, card: QuestionCard): Promise<QuestionAnswer | null>;
  /** Show one step of the bot's run in progress. */
  showRun(conversationId: ConversationId, botId: BotId, step: RunStep): void;
  /** Send a file (already checked by the caller) under the author's name, with an optional caption. */
  postFile(
    conversationId: ConversationId,
    author: Author,
    file: { path: string; name: string },
    caption?: string,
  ): Promise<void>;
}
