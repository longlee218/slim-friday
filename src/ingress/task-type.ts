import type { RecentMessage } from "../intent/intent-types";

/** A unit of work arriving from any ingress (Discord, tests). */
export interface Task {
  /** Where it came from, e.g. "discord". */
  source: string;
  /** Sender id; ingress enforces the owner allowlist. */
  userId: string;
  /** Conversation thread; maps 1:1 to a Claude session. */
  threadId: string;
  /** Routing key: the parent channel of the thread (or the channel of a new conversation). */
  channelId: string;
  text: string;
  /** Id of the ingress message (Discord message id); stored with messages that arrive while a run works. */
  messageId?: string;
  /** The last messages of the thread before this one (owner and bot, redacted, clipped), oldest first; for the intent layer. Absent = none. */
  recent?: RecentMessage[];
  /** Shows at once that the message was received (a reaction on it); used for a message that reaches a busy thread. Never throws. */
  ack?: () => Promise<void>;
  /** Posts a message into the thread while the task still runs (a dispatched plan waits for approval). */
  notify?: (text: string) => Promise<void>;
}
