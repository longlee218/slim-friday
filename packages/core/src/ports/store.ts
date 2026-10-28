import type { Outcome } from "../domain/autonomy";
import type { Bot, BotId } from "../domain/bot";
import type { Conversation, ConversationId } from "../domain/conversation";
import type { FileCursor, FileKind } from "../domain/file-kind";
import type { Grant, RuleEffect } from "../domain/grant";
import type { Group, GroupId } from "../domain/group";
import type { IndexedMessage, StoredMessage } from "../domain/message";
import type { ScratchpadItem } from "../domain/scratchpad";
import type { WakeRow, WakeStatus } from "../domain/wake";
import type { DisabledReason, Schedule, ScheduleRun } from "../schedules/schedule";
import type { Ticket, TicketComment, TicketEvent, TicketStatus } from "../tickets/ticket";
import type { CardPort, EffectPort, ScopePort, SteeringPort } from "./run-state-ports";
import type { ApprovalAnswer } from "./surface";

/** One decision on one tool call, kept for review. */
export interface AuditEntry {
  at: number;
  botId: BotId;
  tool: string;
  outcome: Outcome;
  answer?: ApprovalAnswer;
  reason: string;
  /** The Auto Review verdict on the call (spec §6.14); unset when it was not reviewed. */
  review?: { decision: "pass" | "ask"; reason: string };
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

/** Position in a list of wakes ordered by creation time then id: where the next batch read starts. */
export interface WakeCursor {
  createdAt: number;
  id: string;
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
    /**
     * Allocates the next number in the same step, so two creates never share one.
     * `events` builds history rows from the saved ticket; they are written in the same transaction.
     */
    create(
      t: Omit<Ticket, "id" | "number" | "updatedAt" | "completedAt">,
      opts?: { events?: (next: Ticket) => TicketEvent[] },
    ): Promise<Ticket>;
    get(id: string): Promise<Ticket | undefined>;
    getByNumber(n: number): Promise<Ticket | undefined>;
    /** Tickets of a group that are `todo` or `doing`, oldest first. */
    openOfGroup(groupId: GroupId): Promise<Ticket[]>;
    /** Newest first. `before` is the (createdAt, id) of the last ticket of the previous page. */
    list(f: {
      status?: TicketStatus;
      excludeClosed?: boolean;
      assigneeBotId?: BotId;
      before?: { createdAt: number; id: string };
      limit: number;
    }): Promise<Ticket[]>;
    /**
     * `completedAt` follows `status` (set for done/closed and kept if set, cleared otherwise);
     * `blockedReason` is cleared whenever the resulting status is not `blocked` (`null` clears it too).
     * `updatedAt` becomes `max(now, previous + 1)`, so it moves even within one millisecond.
     * With `ifUpdatedAt` the write happens only when the stored `updatedAt` equals it, else `"conflict"`.
     * `events` builds history rows from the ticket before and after; they are written in the same
     * transaction, so a conflict writes neither the change nor any event.
     */
    update(
      id: string,
      patch: Partial<
        Pick<
          Ticket,
          "title" | "description" | "status" | "priority" | "assigneeBotId" | "blockedBy"
        >
      > & { conversationId?: ConversationId; blockedReason?: string | null },
      now: number,
      opts?: { ifUpdatedAt?: number; events?: (prev: Ticket, next: Ticket) => TicketEvent[] },
    ): Promise<Ticket | "conflict" | undefined>;
    /** Also moves the ticket's `updatedAt` to `max(updatedAt + 1, createdAt)`. */
    addComment(c: Omit<TicketComment, "id">): Promise<TicketComment>;
    /**
     * Insert-or-ignore by `id`. A repeat returns the stored comment with `created: false` and
     * does not move the ticket's `updatedAt`.
     */
    addCommentOnce(
      c: Omit<TicketComment, "id"> & { id: string },
    ): Promise<{ comment: TicketComment; created: boolean }>;
    /** Tickets of `botId` in `groupId` that are not `done` or `closed`, oldest first. */
    activeOfAssignee(botId: BotId, groupId: GroupId): Promise<Ticket[]>;
    /** Tickets whose `blockedBy` contains `id`, oldest first. */
    blockedByTicket(id: string): Promise<Ticket[]>;
    /** Oldest first. */
    comments(ticketId: string): Promise<TicketComment[]>;
    /** Comment count per ticket id; every asked id is present (0 when none). */
    commentCounts(ids: string[]): Promise<Map<string, number>>;
  };
  /** The history of ticket changes. */
  ticketEvents: {
    append(e: TicketEvent): Promise<void>;
    /** Oldest first; rows of the same millisecond keep their insert order. */
    list(ticketId: string): Promise<TicketEvent[]>;
  };
  messages: {
    /** Returns the id of the new message (ids grow with time). */
    append(m: StoredMessage): Promise<number>;
    /** Insert once per `(conversation, clientNonce)`; a repeat returns the first id with `replayed: true`. */
    appendOnce(m: StoredMessage, clientNonce: string): Promise<{ id: number; replayed: boolean }>;
    /** The id stored for `(conversation, clientNonce)`, if any (a retry of a stored message). */
    byNonce(c: ConversationId, clientNonce: string): Promise<number | undefined>;
    get(id: number): Promise<IndexedMessage | undefined>;
    /** Newest first. `before` is the id of the oldest message of the previous page. */
    page(c: ConversationId, f: { before?: number; limit: number }): Promise<IndexedMessage[]>;
    /** The last `limit` messages, oldest first. */
    recent(c: ConversationId, limit: number): Promise<StoredMessage[]>;
    /** Progress messages (`kind: "progress"`) already stored for a wake. */
    countInterim(wakeId: string): Promise<number>;
    /** The newest bot text message (`kind: "text"`) stored for a wake: an answer an earlier attempt already posted. */
    lastText(wakeId: string): Promise<string | undefined>;
    /** The id of the newest message stored for a wake (any kind or author), if any. */
    lastIdOf(wakeId: string): Promise<number | undefined>;
    /** Messages with an id above `afterId`, oldest first, at most `limit` (feeds the message index). */
    after(afterId: number, limit: number): Promise<IndexedMessage[]>;
  };
  files: {
    insert(f: FileRow): Promise<void>;
    get(id: string): Promise<FileRow | undefined>;
    delete(id: string): Promise<void>;
    /** True when a files row holds object `key` (the upload sweeper must keep that object). */
    hasKey(key: string): Promise<boolean>;
    /** The owner's uploads (`source = "upload"`), newest first by `(at, id)`, at most `limit`; `cursor` is the last row of the previous page. */
    listUploads(q: {
      limit: number;
      cursor?: FileCursor;
      kind?: FileKind;
      conversationId?: ConversationId;
    }): Promise<FileRow[]>;
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
  /** Owner rules (spec §6.14; the "always allow" grants of older builds). */
  grants: {
    /** The bot's grants plus the grants for every bot ("*"). */
    list(botId: BotId): Promise<Grant[]>;
    /** Every owner rule of every bot, oldest first (the settings list). */
    all(): Promise<Grant[]>;
    add(g: Grant): Promise<void>;
    revoke(id: string): Promise<void>;
    /** Switches one rule between always allow and always ask; no-op for an unknown id. */
    setEffect(id: string, effect: RuleEffect): Promise<void>;
  };
  /**
   * Runtime session ids by session key (`scopeKeyOf`): `<botId>` (direct), `<botId>@<groupId>` (group) or
   * `<botId>#ticket@<groupId>` (ticket). Ids never contain `@` or `#`. Older rows (key = bot id) stay valid.
   */
  sessions: {
    get(key: string): Promise<string | undefined>;
    set(key: string, sessionId: string): Promise<void>;
    clear(key: string): Promise<void>;
    /** Removes the key `botId` and every `botId@*` and `botId#*`. */
    clearBot(botId: BotId): Promise<void>;
    /** Removes every `*@groupId` (group-chat and ticket keys). */
    clearGroup(groupId: GroupId): Promise<void>;
  };
  spend: {
    add(botId: BotId, day: string, usd: number): Promise<void>;
    total(botId: BotId, day: string): Promise<number>;
    /** Rows from day `from` to day `to` (`YYYY-MM-DD`, both included), ordered by day then bot. */
    range(from: string, to: string): Promise<{ botId: BotId; day: string; usd: number }[]>;
  };
  audit: {
    append(e: AuditEntry): Promise<void>;
    /** Newest first; `toolPrefix` matches the start of the tool name exactly (not a pattern); `limit` is clamped to 1..100. */
    recent(f: { toolPrefix: string; limit: number }): Promise<AuditEntry[]>;
  };
  /** Every message sent into a bot session, with its life and timings. */
  wakes: {
    insert(w: WakeRow): Promise<void>;
    update(id: string, patch: Partial<Omit<WakeRow, "id">>): Promise<void>;
    get(id: string): Promise<WakeRow | undefined>;
    /** Rows with status queued or running, oldest first. */
    open(): Promise<WakeRow[]>;
    /** Rows parked on a card (`waiting_input`), oldest first. */
    waiting(): Promise<WakeRow[]>;
    /** Wakes created at or after `since`, newest first, optionally of one status. */
    list(f: { status?: WakeStatus; since: number; limit: number }): Promise<WakeRow[]>;
    /** Wakes sent by a bot in a conversation created at or after `since`, oldest first. */
    botSentSince(conversationId: ConversationId, since: number): Promise<WakeRow[]>;
    /** Delete rows that ended before `at` (any status but queued, leased, running and waiting_input); returns the count. */
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
    /**
     * The worker `owner` is known dead (its process exited): end the leases of its leased and running rows at
     * `now`, so any worker reclaims them at once. Returns the ids of those rows.
     */
    expireLeasesOf(owner: string, now: number): Promise<string[]>;
    /** Extend the lease to `until` when owner and fence still match; true when it did. */
    renew(id: string, owner: string, fence: number, until: number): Promise<boolean>;
    /** Queued, leased, running and waiting_input rows of a scope, oldest first. */
    activeInScope(scopeKey: string): Promise<WakeRow[]>;
    /** Queued, leased, running and waiting_input rows targeting bot `botId` (any scope), oldest first. */
    activeOfBot(botId: BotId): Promise<WakeRow[]>;
    /** The same rows of every scope of group `groupId` (`<botId>@<groupId>`, `<botId>#ticket@<groupId>`), oldest first. */
    activeOfGroup(groupId: GroupId): Promise<WakeRow[]>;
    /** Rows a worker holds or that are parked: leased, running and waiting_input, oldest first (the status view). */
    inFlight(): Promise<WakeRow[]>;
    /**
     * Finished runs whose outcome still has to go back to the bot that sent them: status done, failed,
     * interrupted, cancelled, expired or dropped; sender a bot; intent request or question; not a hand-off;
     * `outcomeReturnedAt` unset. Oldest first, at most `limit`, after the `after` position (a cursor).
     */
    pendingOutcomes(limit: number, after?: WakeCursor): Promise<WakeRow[]>;
    /**
     * Runs stored but never released: queued with `wakeAt` = `holdUntil`, created before `before` (a crash
     * between insert and cap check). Oldest first, at most `limit`, after the `after` position.
     */
    staleHeld(
      holdUntil: number,
      before: number,
      limit: number,
      after?: WakeCursor,
    ): Promise<WakeRow[]>;
  };
  /** Owner messages sent while a run is busy. */
  steering: SteeringPort;
  /** Working-memory items per session scope. */
  scratchpad: {
    /** Items of one scope, oldest first. */
    list(scopeKey: string, f?: { status?: ScratchpadItem["status"] }): Promise<ScratchpadItem[]>;
    add(
      i: Omit<ScratchpadItem, "id" | "createdAt" | "updatedAt">,
      now: number,
    ): Promise<ScratchpadItem>;
    /** Patch an item of that scope; undefined when the id is not in the scope. */
    update(
      id: string,
      scopeKey: string,
      patch: Partial<Pick<ScratchpadItem, "title" | "status" | "notes">>,
      now: number,
    ): Promise<ScratchpadItem | undefined>;
    /** Delete an item of that scope; false when it is not there. */
    remove(id: string, scopeKey: string): Promise<boolean>;
    /** Delete `done` items last updated before `at`; returns the count. */
    deleteDoneBefore(at: number): Promise<number>;
  };
  /** Scheduled bot runs. */
  schedules: {
    /** Schedules by creation time, optionally of one bot or conversation. */
    list(f?: { botId?: BotId; conversationId?: ConversationId }): Promise<Schedule[]>;
    get(id: string): Promise<Schedule | undefined>;
    insert(s: Schedule): Promise<void>;
    /** Patch a schedule; undefined when the id is unknown. */
    update(
      id: string,
      patch: Partial<Omit<Schedule, "id" | "createdAt" | "createdBy">>,
    ): Promise<Schedule | undefined>;
    /** Compare-and-set on next_run_at: true only when the row still had `expectedNext`. */
    advance(
      id: string,
      expectedNext: number,
      patch: Partial<
        Pick<Schedule, "nextRunAt" | "lastFireAt" | "enabled" | "disabledReason" | "updatedAt">
      >,
    ): Promise<boolean>;
    /** Enabled schedules whose next_run_at is at or before `now`. */
    due(now: number): Promise<Schedule[]>;
    /** Delete a schedule and its runs; false when it is not there. */
    remove(id: string): Promise<boolean>;
    /** Disabled schedules with one of the reasons, last updated before `at`. */
    disabledBefore(reasons: DisabledReason[], at: number): Promise<Schedule[]>;
  };
  /** Fires of schedules. */
  scheduleRuns: {
    insert(r: ScheduleRun): Promise<void>;
    update(
      id: string,
      patch: Partial<Pick<ScheduleRun, "status" | "wakeId" | "endedAt" | "error">>,
    ): Promise<void>;
    /** Runs still `running`. */
    open(): Promise<ScheduleRun[]>;
    /** Add spend to the run of that wake (no-op when none). */
    addCost(wakeId: string, usd: number): Promise<void>;
    /** Newest first by firedAt; `before` keeps only runs fired earlier than it. */
    list(scheduleId: string, limit: number, before?: number): Promise<ScheduleRun[]>;
    /** The newest run (by firedAt) of each asked schedule; a schedule without runs has no entry. */
    latest(scheduleIds: string[]): Promise<Map<string, ScheduleRun>>;
    /** Delete runs fired before `at`; returns the count. */
    deleteBefore(at: number): Promise<number>;
  };
  /** Approval and question cards. */
  cards: CardPort;
  /** Side-effect call records. */
  effects: EffectPort;
  /** Per-scope state. */
  scopes: ScopePort;
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
    /** The status of attempt `id` (`<wakeId>:<fence>`); undefined when there is none. */
    status(id: string): Promise<AttemptStatus | undefined>;
  };
}

/** How one attempt of a run stands. */
export type AttemptStatus =
  | "running"
  | "done"
  | "failed"
  | "interrupted"
  | "parked"
  | "setup_failed";
