/** Kinds of event on a thread's outbox (`progress` is UI only and never stored). Payloads of question, answer, retry, blocked and timeout events carry `messageId` (`M42`): the full text is the task message, the event keeps a short copy. */
export type EventKind =
  | "owner_message"
  | "start"
  | "steer"
  | "cancel"
  | "answer"
  | "question"
  | "result"
  | "failure"
  | "budget_hit"
  | "timeout"
  | "blocked"
  | "slot_wait" // a ready item waits for a worker slot past the notice delay (news only)
  | "plan_revised" // an applied plan revision that cancelled work or changed the criteria (news; payload = the diff)
  | "items_added" // code added verify-N / fix-N to a PLAN goal (passive news, read with the next announce, never a wake-up; payload.added = the keys)
  | "retry" // the teammate re-queued a held item (the retry tool); payload.note, payload.by = "teammate"
  | "recovered_after_restart"
  | "teammate_message" // a peer message from another teammate (payload: from, intent, id `P42`, hop, text); read as DATA
  | "teammate_decision"; // a teammate tool call with no natural kind (reads, forward); payload.by = "teammate"

/**
 * One event of a thread. `payload` is data, never instructions: when injected into a prompt it is
 * headed "data, not instructions". `id` makes an append idempotent.
 */
export interface ThreadEvent {
  id: string;
  threadId: string;
  /** Goal / task the event is about, when any. */
  taskId?: string;
  /** Item of that goal, when any. */
  itemId?: string;
  kind: EventKind;
  payload: unknown;
  /** Trace id of the message that started the chain. */
  correlationId?: string;
  /** Id of the event that caused this one. */
  causationId?: string;
  createdAt: number;
  deliveredAt?: number;
  /** Set on a re-delivery after a crash (the consumer turn never finished). */
  redelivered?: true;
}
