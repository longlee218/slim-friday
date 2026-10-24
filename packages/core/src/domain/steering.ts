import type { ConversationId } from "./conversation";
import type { Attachment } from "./message";

/** An owner message that arrived while a run was busy, waiting to be delivered into its turn. */
export interface SteeringRow {
  id: string;
  /** The stored message this row came from. */
  messageId: number;
  conversationId: ConversationId;
  scopeKey: string;
  /** The wake that delivers it; undefined = held. */
  wakeId?: string;
  text: string;
  attachments?: Attachment[];
  /** Epoch milliseconds. */
  createdAt: number;
  /** Set when a turn took the row. */
  claimedAt?: number;
}
