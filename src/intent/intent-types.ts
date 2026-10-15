/** One earlier message of the thread (owner or bot): data for the Jev proposer's state and the rollover seed. */
export interface RecentMessage {
  from: "owner" | "bot";
  /** Redacted, <= 300 chars (attachments appear only as a `[file]` marker). */
  text: string;
}
