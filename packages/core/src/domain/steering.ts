import type { ConversationId } from "./conversation";
import type { Attachment } from "./message";

/** An owner message that arrived while a run was busy, waiting to be delivered into its turn. */
export interface SteeringRow {
  /** Row id. */
  id: string;
  /** The stored message this row came from. */
  messageId: number;
  /** Conversation the message was sent in. */
  conversationId: ConversationId;
  /** Session scope the row belongs to. */
  scopeKey: string;
  /** The wake that delivers it; undefined = held. */
  wakeId?: string;
  /** Message text. */
  text: string;
  /** Files sent with it. */
  attachments?: Attachment[];
  /** Epoch milliseconds. */
  createdAt: number;
  /** Set when a turn took the row. */
  claimedAt?: number;
}
