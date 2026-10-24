import type { BotId } from "./bot";
import type { ConversationId } from "./conversation";
import type { Attachment, Author } from "./message";

/** Where a wake is in its life. `done` ended normally; the others are explained by `blockReason` or the recovery. */
export type WakeStatus =
  | "queued"
  | "running"
  | "done"
  | "blocked"
  | "interrupted"
  | "expired"
  | "dropped"
  | "leased"
  | "waiting_input"
  | "failed"
  | "cancelled";

/** Why a cap stopped a wake. */
export type BlockReason = "hops" | "rate" | "repeat" | "spend";

/** What the sender wants from the receiver (a user message counts as `request`). */
export const WAKE_INTENTS = ["request", "question", "result", "status", "fyi"] as const;
export type WakeIntent = (typeof WAKE_INTENTS)[number];

/** One message delivered (or to be delivered) into one bot's session; one wake is one turn. */
export interface WakeRow {
  id: string;
  /** Id of the user wake that started the chain this wake belongs to. */
  chainId: string;
  /** The wake that was running when the sender sent this one; none for a user message. */
  parentWakeId?: string;
  conversationId: ConversationId;
  targetBot: BotId;
  sender: Author;
  intent: WakeIntent;
  /** Hand-offs since the user message that started the chain. */
  hop: number;
  text: string;
  attachments?: Attachment[];
  /** The ticket this wake works on (a ticket wake). */
  ticketId?: string;
  /** The second wake for a ticket left open after a turn. */
  rewake?: boolean;
  /** Created by `HandOff`: the receiver owns the step and does not answer the sender. */
  handoff?: boolean;
  status: WakeStatus;
  blockReason?: BlockReason;
  /** Times this wake was sent into a session (2 after a restart re-send). */
  attempts: number;
  /** Epoch milliseconds. */
  createdAt: number;
  startedAt?: number;
  firstTextAt?: number;
  endedAt?: number;
  /** Runs sharing a scope key never run in parallel. */
  scopeKey: string;
  /** `interactive` runs are claimed before `background` ones. */
  priority: "interactive" | "background";
  /** `<bootId>:<workerId>` of the worker holding the lease. */
  leaseOwner?: string;
  /** Raised by one at every claim; a stale holder's writes are refused. */
  leaseFence: number;
  leaseExpiresAt?: number;
  /** Not claimable before this time. */
  wakeAt?: number;
  cardId?: string;
  tainted?: boolean;
  resultText?: string;
  error?: string;
  outcomeReturnedAt?: number;
  /** Unique per conversation when set. */
  dedupeKey?: string;
  cuts: number;
  transientRetries: number;
  setupFailures: number;
}
