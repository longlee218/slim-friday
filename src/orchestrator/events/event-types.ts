/** Kinds of event on a thread's outbox (`progress` is UI only and never stored). */
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
  | "retry" // the lead re-queued a held item (the retry tool); payload.note, payload.by = "lead"
  | "recovered_after_restart"
  | "lead_decision"; // a lead tool call with no natural kind (reads, forward); payload.by = "lead"

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
