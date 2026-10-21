import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A Discord thread the bot knows (created by the bot or adopted). */
export const threads = sqliteTable(
  "threads",
  {
    /** Thread id. */
    thread_id: text().primaryKey(),
    /** Parent channel id. */
    channel_id: text().notNull(),
    /** Workspace of the channel. */
    workspace: text().notNull().default(""),
    /** `bot` or `adopted`. */
    origin: text().notNull(),
    /** Placeholder name the thread started with (renamed once). */
    placeholder: text(),
    /** Title set by Orchestrate set_title. */
    title: text(),
    /** Short digest of the thread for the channel digest. */
    digest: text(),
    /** Epoch ms created. */
    created_at: integer().notNull(),
    /** Epoch ms last updated. */
    updated_at: integer().notNull(),
  },
  (t) => [index("threads_channel_updated").on(t.channel_id, t.updated_at)],
);

/** One episode per thread: the SDK compaction summary or an idle-thread summary, plus the flush state and dreaming mark. */
export const thread_summaries = sqliteTable("thread_summaries", {
  /** Thread id. */
  thread_id: text().primaryKey(),
  /** Workspace of the thread. */
  workspace: text().notNull().default(""),
  /** Summary text. */
  summary: text().notNull(),
  /** Channel (yaml name) of the thread; '' = unknown (rows from before migration 0009: never dreamed, pruned by TTL). */
  channel: text().notNull().default(""),
  /** Top terms of the summary, space separated (extractive, no model). */
  key_topics: text().notNull().default(""),
  /** First sentences of the summary (extractive, at most EPISODE_ABSTRACT_CHARS). */
  abstract: text().notNull().default(""),
  /** Epoch ms dreaming consumed this episode (0 = not yet); re-eligible when `updated_at` is newer. */
  promoted_at: integer().notNull().default(0),
  /** Epoch ms last updated. */
  updated_at: integer().notNull(),
  /** Compaction cycle counter. */
  cycle: integer().notNull().default(0),
  /** Last cycle flushed to memory (-1 = none). */
  flushed_cycle: integer().notNull().default(-1),
});
