import type { ReportLink } from "./discord-message-rules";
import type { RecentMessage } from "./intent-types";
import type { OwnerLanguage } from "./user-copy";

/** A unit of work arriving from any ingress (Discord, tests). */
export interface InboundMessage {
  /** Where it came from, e.g. "discord". */
  source: string;
  /** Sender id; ingress enforces the owner allowlist. */
  userId: string;
  /** Conversation thread; maps 1:1 to a Claude session. */
  threadId: string;
  /** Routing key: the parent channel of the thread (or the channel of a new conversation). */
  channelId: string;
  text: string;
  /** Conversation language pinned by ingress. */
  language?: OwnerLanguage;
  /** Id of the ingress message (Discord message id); stored with messages that arrive while a run works. */
  messageId?: string;
  /** Id of the message this one is a Discord reply to; a reply to a task's question message answers that task. */
  replyToMessageId?: string;
  /** The last messages of the thread before this one (owner and bot, redacted, clipped), oldest first; for the lead. Absent = none. */
  recent?: RecentMessage[];
  /** Marks the first visible response as posted (settles the 👀 receipt, stops typing): called after a successful question post. */
  visible?: () => Promise<void>;
  /**
   * Posts a message into the thread while the turn still runs (a dispatched plan waits for approval).
   * `asFile`: the text is a finished result, posted as an attached file with a short label, never inline;
   * `fileName`: that file's name (from the result's title); `links`: link buttons of the file's message (the viewer's "Open").
   */
  notify?: (
    text: string,
    opts?: { asFile?: boolean; fileName?: string; links?: ReportLink[] },
  ) => Promise<void>;
}
