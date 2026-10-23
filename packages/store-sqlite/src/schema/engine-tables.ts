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

/** The SDK session id of each bot (kept so the next message resumes it). */
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
