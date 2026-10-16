/** One earlier message of the thread (owner or bot): data for the rollover seed. */
export interface RecentMessage {
  from: "owner" | "bot";
  /** Redacted, <= 300 chars (attachments appear only as a `[file]` marker). */
  text: string;
}
