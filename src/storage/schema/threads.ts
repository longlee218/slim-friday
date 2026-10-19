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

/** Rolling summary of a thread (rollover seed and memory flush state). */
export const thread_summaries = sqliteTable("thread_summaries", {
  /** Thread id. */
  thread_id: text().primaryKey(),
  /** Workspace of the thread. */
  workspace: text().notNull().default(""),
  /** Summary text. */
  summary: text().notNull(),
  /** Epoch ms of the last rollover. */
  rolled_at: integer().notNull().default(0),
  /** Epoch ms last updated. */
  updated_at: integer().notNull(),
  /** Compaction cycle counter. */
  cycle: integer().notNull().default(0),
  /** Last cycle flushed to memory (-1 = none). */
  flushed_cycle: integer().notNull().default(-1),
});
