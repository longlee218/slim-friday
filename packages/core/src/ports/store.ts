import type { Outcome } from "../domain/autonomy";
import type { Bot, BotId } from "../domain/bot";
import type { Conversation, ConversationId } from "../domain/conversation";
import type { Grant } from "../domain/grant";
import type { Group, GroupId } from "../domain/group";
import type { IndexedMessage, StoredMessage } from "../domain/message";
import type { WakeRow } from "../domain/wake";
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

/** Everything the engine persists. */
export interface Store {
  bots: { get(id: BotId): Promise<Bot | undefined>; list(): Promise<Bot[]> };
  groups: { get(id: GroupId): Promise<Group | undefined> };
  conversations: {
    get(id: ConversationId): Promise<Conversation | undefined>;
    /** The one-to-one conversation of a bot. */
    direct(botId: BotId): Promise<Conversation | undefined>;
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
    append(m: StoredMessage): Promise<void>;
    /** The last `limit` messages, oldest first. */
    recent(c: ConversationId, limit: number): Promise<StoredMessage[]>;
    /** Messages with an id above `afterId`, oldest first, at most `limit` (feeds the message index). */
    after(afterId: number, limit: number): Promise<IndexedMessage[]>;
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
  };
}
