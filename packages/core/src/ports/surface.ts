import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Author } from "../domain/message";

/** A message from the user, as the surface delivers it. */
export interface InboundMessage {
  conversationId: ConversationId;
  text: string;
}

export interface OutboundMessage {
  author: Author;
  text: string;
}

/** What the user is asked when a call needs approval. */
export interface ApprovalCard {
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
  onMessage(handler: (m: InboundMessage) => void): void;
  post(conversationId: ConversationId, m: OutboundMessage): Promise<void>;
  askApproval(conversationId: ConversationId, card: ApprovalCard): Promise<ApprovalAnswer>;
  showActivity(conversationId: ConversationId, a: Activity): void;
}
