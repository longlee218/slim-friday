import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    /** `text`, `file` or `relay`. */
    kind: text("kind").notNull().default("text"),
    /** Id of the message this one replies to. */
    replyTo: integer("reply_to"),
    /** JSON `FileRef[]`. */
    files: text("files"),
    /** JSON `RunStep[]`. */
    run: text("run"),
    /** JSON `RelayInfo`. */
    relay: text("relay"),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.id)],
);

/** Stored "always allow" decisions. */
export const grants = sqliteTable(
  "grants",
  {
    id: text("id").primaryKey(),
    /** A bot id, or `*` for every bot. */
    botId: text("bot_id").notNull(),
    tool: text("tool").notNull(),
    /** JSON object: scope key to value. */
    scope: text("scope").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
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
  },
  (t) => [
    index("wakes_status_idx").on(t.status, t.createdAt),
    index("wakes_conversation_idx").on(t.conversationId, t.createdAt),
  ],
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
    /** `pending` or `used`. */
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
