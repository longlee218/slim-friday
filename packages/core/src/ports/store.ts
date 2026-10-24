import type { Outcome } from "../domain/autonomy";
import type { Bot, BotId } from "../domain/bot";
import type { Conversation, ConversationId } from "../domain/conversation";
import type { Grant } from "../domain/grant";
import type { Group, GroupId } from "../domain/group";
import type { IndexedMessage, StoredMessage } from "../domain/message";
import type { WakeRow, WakeStatus } from "../domain/wake";
import type { Ticket, TicketComment, TicketStatus } from "../tickets/ticket";
import type { ApprovalAnswer } from "./surface";

/** One decision on one tool call, kept for review. */
export interface AuditEntry {
  at: number;
  botId: BotId;
  tool: string;
  outcome: Outcome;
  answer?: ApprovalAnswer;
  reason: string;
}

/** A stored file (an R2 object) that a message can carry. */
export interface FileRow {
  id: string;
  /** Object key in the file store. */
  key: string;
  conversationId: ConversationId;
  name: string;
  mimeType: string;
  size: number;
  /** Pixel size, set for images only. */
  width?: number;
  height?: number;
  /** Who made it: the owner's upload or a bot (`PostFile`). */
  source: "upload" | "bot";
  /** Epoch milliseconds. */
  at: number;
}

/** A file the owner uploaded (or an avatar) that is waiting to be used. */
export interface UploadRow {
  id: string;
  /** Object key in the file store. */
  key: string;
  /** Null for avatars. */
  conversationId: ConversationId | null;
  purpose: "chat" | "avatar";
  name: string;
  mimeType: string;
  size: number;
  state: "pending" | "claimed" | "used";
  /** The message that used it, once used. */
  messageId?: number;
  /** Epoch milliseconds. */
  at: number;
}

/** Everything the engine persists. */
export interface Store {
  bots: { get(id: BotId): Promise<Bot | undefined>; list(): Promise<Bot[]> };
  groups: { get(id: GroupId): Promise<Group | undefined> };
  conversations: {
    get(id: ConversationId): Promise<Conversation | undefined>;
    /** The one-to-one conversation of a bot. */
    direct(botId: BotId): Promise<Conversation | undefined>;
    /** Every conversation. */
    list(): Promise<Conversation[]>;
    /** Deletes every conversation whose id is not `bot:*` or `group:*` and its messages; returns the conversation count. */
    deleteLegacy(): Promise<number>;
  };
  /** The shared ticket board. */
  tickets: {
    /** Allocates the next number in the same step, so two creates never share one. */
    create(t: Omit<Ticket, "id" | "number" | "updatedAt" | "completedAt">): Promise<Ticket>;
    get(id: string): Promise<Ticket | undefined>;
    getByNumber(n: number): Promise<Ticket | undefined>;
    /** Newest first. `before` is the (createdAt, id) of the last ticket of the previous page. */
    list(f: {
      status?: TicketStatus;
      excludeClosed?: boolean;
      assigneeBotId?: BotId;
      before?: { createdAt: number; id: string };
      limit: number;
    }): Promise<Ticket[]>;
    /** `completedAt` follows `status` (set for done/closed and kept if set, cleared otherwise). */
    update(
      id: string,
      patch: Partial<
        Pick<Ticket, "title" | "description" | "status" | "priority" | "assigneeBotId">
      >,
      now: number,
    ): Promise<Ticket | undefined>;
    /** Also bumps the ticket's `updatedAt`. */
    addComment(c: Omit<TicketComment, "id">): Promise<TicketComment>;
    /** Oldest first. */
    comments(ticketId: string): Promise<TicketComment[]>;
  };
  messages: {
    /** Returns the id of the new message (ids grow with time). */
    append(m: StoredMessage): Promise<number>;
    get(id: number): Promise<IndexedMessage | undefined>;
    /** Newest first. `before` is the id of the oldest message of the previous page. */
    page(c: ConversationId, f: { before?: number; limit: number }): Promise<IndexedMessage[]>;
    /** The last `limit` messages, oldest first. */
    recent(c: ConversationId, limit: number): Promise<StoredMessage[]>;
    /** Messages with an id above `afterId`, oldest first, at most `limit` (feeds the message index). */
    after(afterId: number, limit: number): Promise<IndexedMessage[]>;
  };
  files: {
    insert(f: FileRow): Promise<void>;
    get(id: string): Promise<FileRow | undefined>;
    delete(id: string): Promise<void>;
  };
  uploads: {
    insert(u: UploadRow): Promise<void>;
    get(id: string): Promise<UploadRow | undefined>;
    markUsed(id: string, messageId: number | null): Promise<void>;
    /** Atomically take a pending upload (pending -> claimed); false when it was not pending. */
    claim(id: string): Promise<boolean>;
    /** Give a claimed upload back (claimed -> pending). */
    release(id: string): Promise<void>;
    /** Unused (pending or claimed) uploads created before `at`, oldest first. */
    pendingBefore(at: number): Promise<UploadRow[]>;
    delete(id: string): Promise<void>;
  };
  /** How far the owner has read each conversation. */
  reads: {
    /** The last read message id; 0 when never read. */
    get(c: ConversationId): Promise<number>;
    /** Keeps the larger of the old and new position. */
    set(c: ConversationId, messageId: number): Promise<void>;
    /** Messages of `c` above the read position whose author is not the owner. */
    unread(c: ConversationId): Promise<number>;
  };
  grants: {
    /** The bot's grants plus the grants for every bot ("*"). */
    list(botId: BotId): Promise<Grant[]>;
    add(g: Grant): Promise<void>;
    revoke(id: string): Promise<void>;
  };
  /**
   * Runtime session ids by session key: `<botId>` (direct) or `<botId>@<groupId>` (group).
   * Ids never contain `@`. Older rows (key = bot id) stay valid as direct sessions.
   */
  sessions: {
    get(key: string): Promise<string | undefined>;
    set(key: string, sessionId: string): Promise<void>;
    clear(key: string): Promise<void>;
    /** Removes the key `botId` and every `botId@*`. */
    clearBot(botId: BotId): Promise<void>;
    /** Removes every `*@groupId`. */
    clearGroup(groupId: GroupId): Promise<void>;
  };
  spend: {
    add(botId: BotId, day: string, usd: number): Promise<void>;
    total(botId: BotId, day: string): Promise<number>;
  };
  audit: { append(e: AuditEntry): Promise<void> };
  /** Every message sent into a bot session, with its life and timings. */
  wakes: {
    insert(w: WakeRow): Promise<void>;
    update(id: string, patch: Partial<Omit<WakeRow, "id">>): Promise<void>;
    get(id: string): Promise<WakeRow | undefined>;
    /** Rows with status queued or running, oldest first. */
    open(): Promise<WakeRow[]>;
    /** Wakes sent by a bot in a conversation created at or after `since`, oldest first. */
    botSentSince(conversationId: ConversationId, since: number): Promise<WakeRow[]>;
    /** Delete rows that ended before `at` (any status but queued and running); returns the count. */
    deleteFinishedBefore(at: number): Promise<number>;
    /** Insert unless a row with the same conversation and `dedupeKey` exists; then return that row. */
    insertDeduped(w: WakeRow): Promise<{ inserted: true } | { inserted: false; existing: WakeRow }>;
    /**
     * In one transaction lease the next claimable run (queued and due with a free scope, or a lease that
     * expired or belongs to another boot): interactive first, then oldest. Raises the fence by one.
     */
    claimNext(o: {
      owner: string;
      bootId: string;
      now: number;
      leaseMs: number;
    }): Promise<WakeRow | undefined>;
    /** Apply `patch` only when the row has this fence and one of the `from` statuses; true when it did. */
    transition(
      id: string,
      fence: number,
      from: WakeStatus[],
      patch: Partial<WakeRow>,
    ): Promise<boolean>;
    /** Extend the lease to `until` when owner and fence still match; true when it did. */
    renew(id: string, owner: string, fence: number, until: number): Promise<boolean>;
    /** Queued, leased, running and waiting_input rows of a scope, oldest first. */
    activeInScope(scopeKey: string): Promise<WakeRow[]>;
  };
  /** Tries of a run. */
  attempts: {
    start(a: {
      id: string;
      wakeId: string;
      fence: number;
      owner: string;
      startedAt: number;
    }): Promise<void>;
    finish(
      id: string,
      status: "done" | "failed" | "interrupted" | "parked" | "setup_failed",
      at: number,
      error?: string,
    ): Promise<void>;
  };
}
