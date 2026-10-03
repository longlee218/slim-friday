/** A unit of work arriving from any ingress (Discord in 1b, tests now). */
export interface Task {
  /** Where it came from, e.g. "discord". */
  source: string;
  /** Sender id; ingress enforces the owner allowlist. */
  userId: string;
  /** Conversation thread; maps 1:1 to a Claude session. */
  threadId: string;
  text: string;
}
