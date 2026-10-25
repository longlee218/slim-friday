import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** A message stream: a one-to-one chat with a bot or a group chat. */
export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  /** `direct` or `group`. */
  kind: text("kind").notNull(),
  botId: text("bot_id"),
  groupId: text("group_id"),
});

/** Every message of every conversation. */
export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: text("conversation_id").notNull(),
    /** `user`, `bot` or `system`. */
    authorKind: text("author_kind").notNull(),
    authorBotId: text("author_bot_id"),
    text: text("text").notNull(),
    /** Epoch milliseconds. */
    at: integer("at").notNull(),
    /** `text`, `file`, `relay` or `progress`. */
    kind: text("kind").notNull().default("text"),
    /** Id of the message this one replies to. */
    replyTo: integer("reply_to"),
    /** JSON `FileRef[]`. */
    files: text("files"),
    /** JSON `RunStep[]`. */
    run: text("run"),
    /** JSON `RelayInfo`. */
    relay: text("relay"),
    /** Client-chosen id that makes a send idempotent; null for messages without one. */
    clientNonce: text("client_nonce"),
    /** The wake (run) that produced the message; null for messages without one. */
    wakeId: text("wake_id"),
    /** The schedule whose run posted the message; outlives the schedule and the wake. */
    scheduleId: text("schedule_id"),
    /** That schedule's name when the run started; null when it was already gone. */
    scheduleName: text("schedule_name"),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.id),
    index("messages_wake_idx").on(t.wakeId),
    uniqueIndex("messages_conversation_nonce_uq").on(t.conversationId, t.clientNonce),
  ],
);

/** Owner rules (spec §6.14): always-allow and require-approval decisions by site, tool, server or category. */
export const grants = sqliteTable(
  "grants",
  {
    id: text("id").primaryKey(),
    /** A bot id, or `*` for every bot. */
    botId: text("bot_id").notNull(),
    /** The matched value: tool name, site (registrable domain), MCP server id or category, by `match_kind`. */
    tool: text("tool").notNull(),
    /** JSON object: scope key to value (only `tool` rules have keys). */
    scope: text("scope").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    /** `always_allow` | `require_approval`; rows of older builds are always-allow grants. */
    effect: text("effect").notNull().default("always_allow"),
    /** `site` | `tool` | `server` | `category`; rows of older builds are tool grants. */
    matchKind: text("match_kind").notNull().default("tool"),
  },
  (t) => [index("grants_bot_idx").on(t.botId)],
);

/**
 * The SDK session id per session key (kept so the next message resumes it). The `bot_id`
 * column holds the key: `<botId>` (direct) or `<botId>@<groupId>` (group).
 */
export const sessions = sqliteTable("sessions", {
  botId: text("bot_id").primaryKey(),
  sessionId: text("session_id").notNull(),
});

/** Money spent per bot per day. */
export const spend = sqliteTable(
  "spend",
  {
    botId: text("bot_id").notNull(),
    /** `YYYY-MM-DD`. */
    day: text("day").notNull(),
    usd: real("usd").notNull(),
  },
  (t) => [primaryKey({ columns: [t.botId, t.day] })],
);

/** One row per permission decision. */
export const audit = sqliteTable("audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  botId: text("bot_id").notNull(),
  tool: text("tool").notNull(),
  outcome: text("outcome").notNull(),
  answer: text("answer"),
  reason: text("reason").notNull(),
  /** The Auto Review verdict as JSON (`{ decision, reason }`); null when the call was not reviewed. */
  review: text("review"),
});

/** One row per message sent into a bot session: its chain, intent, state and timings. */
export const wakes = sqliteTable(
  "wakes",
  {
    id: text("id").primaryKey(),
    chainId: text("chain_id").notNull(),
    parentWakeId: text("parent_wake_id"),
    conversationId: text("conversation_id").notNull(),
    targetBot: text("target_bot").notNull(),
    /** `user`, `bot` or `system`. */
    senderKind: text("sender_kind").notNull(),
    senderBotId: text("sender_bot_id"),
    intent: text("intent").notNull(),
    hop: integer("hop").notNull(),
    text: text("text").notNull(),
    /** JSON array of attachments (saved paths), if any. */
    attachments: text("attachments"),
    handoff: integer("handoff", { mode: "boolean" }),
    ticketId: text("ticket_id"),
    rewake: integer("rewake", { mode: "boolean" }),
    status: text("status").notNull(),
    blockReason: text("block_reason"),
    attempts: integer("attempts").notNull(),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    firstTextAt: integer("first_text_at"),
    endedAt: integer("ended_at"),
    /** Runs with the same scope key never run in parallel (a bot session scope). */
    scopeKey: text("scope_key").notNull().default(""),
    /** `interactive` runs are claimed before `background` ones. */
    priority: text("priority").notNull().default("interactive"),
    /** `<bootId>:<workerId>` of the worker holding the lease. */
    leaseOwner: text("lease_owner"),
    /** Raised by one at every claim; a stale holder's writes are refused. */
    leaseFence: integer("lease_fence").notNull().default(0),
    /** When the lease ends; after it another worker may reclaim the run. */
    leaseExpiresAt: integer("lease_expires_at"),
    /** Not claimable before this time. */
    wakeAt: integer("wake_at"),
    /** The activity card that shows this run. */
    cardId: text("card_id"),
    /** Set when the run read untrusted input. */
    tainted: integer("tainted", { mode: "boolean" }),
    /** The final answer text of the run. */
    resultText: text("result_text"),
    /** Why the run failed. */
    error: text("error"),
    /** When the outcome was returned to the sender. */
    outcomeReturnedAt: integer("outcome_returned_at"),
    /** Unique per conversation when set: a repeated delivery finds the first row. */
    dedupeKey: text("dedupe_key"),
    /** Times the run was cut short and continued. */
    cuts: integer("cuts").notNull().default(0),
    /** Retries after transient errors. */
    transientRetries: integer("transient_retries").notNull().default(0),
    /** Failures before the session started. */
    setupFailures: integer("setup_failures").notNull().default(0),
    /** JSON `{ author, text }` of the message the owner replied to, sent with the run's turn. */
    quote: text("quote"),
    /** The first run of a new bot with the owner. */
    intro: integer("intro", { mode: "boolean" }),
    /** The schedule that fired this wake, and whether it stays quiet unless there is a problem. */
    scheduleId: text("schedule_id"),
    scheduleQuiet: integer("schedule_quiet", { mode: "boolean" }),
    /** Nudges sent to the run when it ended without a final answer. */
    nudges: integer("nudges").notNull().default(0),
  },
  (t) => [
    index("wakes_status_idx").on(t.status, t.createdAt),
    index("wakes_conversation_idx").on(t.conversationId, t.createdAt),
    index("wakes_claim_idx").on(t.status, t.priority, t.createdAt),
    index("wakes_scope_idx").on(t.scopeKey, t.status),
    uniqueIndex("wakes_dedupe_idx").on(t.conversationId, t.dedupeKey),
  ],
);

/** One try of a run by one worker under one fence. */
export const runAttempts = sqliteTable(
  "run_attempts",
  {
    id: text("id").primaryKey(),
    wakeId: text("wake_id").notNull(),
    fence: integer("fence").notNull(),
    owner: text("owner").notNull(),
    /** `running` until finished, then done, failed, interrupted, parked or setup_failed. */
    status: text("status").notNull(),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [index("run_attempts_wake_idx").on(t.wakeId)],
);

/** Tickets of the shared board. */
export const tickets = sqliteTable(
  "tickets",
  {
    id: text("id").primaryKey(),
    number: integer("number").notNull().unique(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull(),
    priority: text("priority").notNull(),
    assigneeBotId: text("assignee_bot_id"),
    /** `user`, `bot` or `system`. */
    createdByKind: text("created_by_kind").notNull(),
    createdByBotId: text("created_by_bot_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    completedAt: integer("completed_at"),
    /** The conversation the ticket was raised in. */
    conversationId: text("conversation_id"),
    /** Why the ticket is `blocked`. */
    blockedReason: text("blocked_reason"),
  },
  (t) => [index("tickets_created_idx").on(t.createdAt, t.id)],
);

/** Comments on tickets. */
export const ticketComments = sqliteTable(
  "ticket_comments",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id").notNull(),
    authorKind: text("author_kind").notNull(),
    authorBotId: text("author_bot_id"),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("ticket_comments_ticket_idx").on(t.ticketId, t.createdAt)],
);

/** One row: the last ticket number handed out (numbers are never reused, even after a delete). */
export const ticketCounter = sqliteTable("ticket_counter", {
  id: integer("id").primaryKey(),
  last: integer("last").notNull(),
});

/** Files (R2 objects) carried by messages. */
export const files = sqliteTable("files", {
  id: text("id").primaryKey(),
  /** Object key in the file store. */
  key: text("key").notNull(),
  conversationId: text("conversation_id").notNull(),
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  /** Pixel size, images only. */
  width: integer("width"),
  height: integer("height"),
  /** `upload` or `bot`. */
  source: text("source").notNull(),
  /** Epoch milliseconds. */
  at: integer("at").notNull(),
});

/** Uploads waiting to be used by a message or an avatar. */
export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    /** Object key in the file store. */
    key: text("key").notNull(),
    /** Null for avatars. */
    conversationId: text("conversation_id"),
    /** `chat` or `avatar`. */
    purpose: text("purpose").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    /** `pending`, `claimed` (a send is using it) or `used`. */
    state: text("state").notNull(),
    /** The message that used it. */
    messageId: integer("message_id"),
    /** Epoch milliseconds. */
    at: integer("at").notNull(),
  },
  (t) => [index("uploads_state_idx").on(t.state, t.at)],
);

/** The last message the owner has read, per conversation. */
export const conversationReads = sqliteTable("conversation_reads", {
  conversationId: text("conversation_id").primaryKey(),
  messageId: integer("message_id").notNull(),
});

/** History of ticket changes (written by the ticket board in a later plan). */
export const ticketEvents = sqliteTable(
  "ticket_events",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id").notNull(),
    /** `created`, `status`, `assignee`, `priority` or `handoff`. */
    kind: text("kind").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    /** `user`, `bot` or `system`. */
    actorKind: text("actor_kind").notNull(),
    actorBotId: text("actor_bot_id"),
    /** Epoch milliseconds. */
    at: integer("at").notNull(),
  },
  (t) => [index("ticket_events_ticket_idx").on(t.ticketId, t.at)],
);

/** Owner messages that arrive while a run is busy; bound to a wake, then claimed by its turn. */
export const steering = sqliteTable(
  "steering",
  {
    id: text("id").primaryKey(),
    /** The stored message this row came from. */
    messageId: integer("message_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    scopeKey: text("scope_key").notNull(),
    /** The wake that will deliver it; null while the row is held. */
    wakeId: text("wake_id"),
    text: text("text").notNull(),
    /** JSON `Attachment[]`. */
    attachments: text("attachments"),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
    /** Set when a turn took the row; null until then. */
    claimedAt: integer("claimed_at"),
  },
  (t) => [
    index("steering_wake_idx").on(t.wakeId, t.createdAt),
    index("steering_scope_idx").on(t.scopeKey),
  ],
);

/** Approval and question cards put to the owner by a run. */
export const cards = sqliteTable(
  "cards",
  {
    id: text("id").primaryKey(),
    /** `approval` or `question`. */
    kind: text("kind").notNull(),
    wakeId: text("wake_id").notNull(),
    botId: text("bot_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    scopeKey: text("scope_key").notNull(),
    /** JSON approval details (approval cards only). */
    approval: text("approval"),
    /** JSON `QuestionCard` (question cards only). */
    question: text("question"),
    /** `open`, `answered`, `withdrawn` or `used`. */
    status: text("status").notNull(),
    /** JSON `ApprovalAnswer` or `QuestionAnswer`. */
    answer: text("answer"),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
    answeredAt: integer("answered_at"),
    /** When the owner was reminded (once). */
    remindedAt: integer("reminded_at"),
    /** The owner message whose typed text answered the card; null otherwise. */
    answeredMessageId: integer("answered_message_id"),
  },
  (t) => [
    index("cards_status_idx").on(t.status),
    index("cards_scope_idx").on(t.scopeKey, t.status),
    index("cards_answered_message_idx").on(t.answeredMessageId),
  ],
);

/** Side-effect tool calls, so a replayed run does not repeat one that already ran. */
export const effectCalls = sqliteTable("effect_calls", {
  /** Idempotency key of the call. */
  key: text("key").primaryKey(),
  wakeId: text("wake_id").notNull(),
  tool: text("tool").notNull(),
  /** `started` or `done`. */
  state: text("state").notNull(),
  /** The stored result once done. */
  result: text("result"),
  /** Epoch milliseconds. */
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
});

/** Small per-scope state that outlives a run. */
export const scopes = sqliteTable("scopes", {
  key: text("key").primaryKey(),
  /** Effort chosen for the scope; null = bot default. */
  effort: text("effort"),
  /** 1 when the next session of the scope must start fresh. */
  resetPending: integer("reset_pending").notNull().default(0),
  /** Epoch ms of the last finished run. */
  lastFinishedAt: integer("last_finished_at"),
  /** Epoch ms of the last memory flush. */
  lastFlushedAt: integer("last_flushed_at"),
});

/** OAuth login of an MCP server (tokens are secrets: never logged). */
export const mcpOAuth = sqliteTable("mcp_oauth", {
  /** Server name as in the MCP config. */
  server: text("server").primaryKey(),
  serverUrl: text("server_url").notNull(),
  clientId: text("client_id").notNull(),
  refreshToken: text("refresh_token").notNull(),
  accessToken: text("access_token"),
  /** Epoch milliseconds. */
  accessExpiresAt: integer("access_expires_at"),
  /** `connected` or `needs_login`. */
  status: text("status").notNull(),
  /** Epoch milliseconds. */
  lastRefreshAt: integer("last_refresh_at"),
  lastError: text("last_error"),
  /** Epoch milliseconds. */
  updatedAt: integer("updated_at").notNull(),
});

/** Working-memory items of a bot session scope (`<botId>` or `<botId>@<groupId>`). */
export const scratchpad = sqliteTable(
  "scratchpad",
  {
    id: text("id").primaryKey(),
    /** One list per scope key. */
    scopeKey: text("scope_key").notNull(),
    botId: text("bot_id").notNull(),
    title: text("title").notNull(),
    /** `open`, `parked` or `done`. */
    status: text("status").notNull(),
    notes: text("notes").notNull().default(""),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("scratchpad_scope_idx").on(t.scopeKey, t.createdAt),
    index("scratchpad_status_idx").on(t.status, t.updatedAt),
  ],
);

/** Scheduled bot runs. */
export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    botId: text("bot_id").notNull(),
    task: text("task").notNull(),
    /** JSON `RepeatRule`. */
    rule: text("rule").notNull(),
    timeZone: text("time_zone").notNull(),
    conversationId: text("conversation_id").notNull(),
    /** `always` or `problems`. */
    notify: text("notify").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    /** Epoch ms of the next fire; null when nothing is left to fire. */
    nextRunAt: integer("next_run_at"),
    lastFireAt: integer("last_fire_at"),
    /** `bot_gone`, `group_gone` or `done` when the engine switched it off. */
    disabledReason: text("disabled_reason"),
    /** JSON `Author`. */
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("schedules_due_idx").on(t.enabled, t.nextRunAt)],
);

/** One fire of a schedule. */
export const scheduleRuns = sqliteTable(
  "schedule_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id").notNull(),
    dueAt: integer("due_at").notNull(),
    firedAt: integer("fired_at").notNull(),
    manual: integer("manual", { mode: "boolean" }).notNull(),
    late: integer("late", { mode: "boolean" }).notNull(),
    /** `running`, `ok`, `problem`, `failed` or `skipped`. */
    status: text("status").notNull(),
    wakeId: text("wake_id"),
    endedAt: integer("ended_at"),
    costUsd: real("cost_usd").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    index("schedule_runs_schedule_idx").on(t.scheduleId, t.firedAt),
    index("schedule_runs_status_idx").on(t.status),
    index("schedule_runs_wake_idx").on(t.wakeId),
  ],
);
