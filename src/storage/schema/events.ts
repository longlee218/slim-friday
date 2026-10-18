import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Durable event queue of a thread: the lead is woken by undelivered rows. */
export const thread_events = sqliteTable(
  "thread_events",
  {
    /** Order of the queue. */
    seq: integer().primaryKey({ autoIncrement: true }),
    /** Event id (unique: idempotent inserts). */
    id: text().notNull().unique(),
    /** Thread of the event. */
    thread_id: text().notNull(),
    /** Task the event is about. */
    task_id: text(),
    /** Item the event is about. */
    item_id: text(),
    /** Event kind. */
    kind: text().notNull(),
    /** JSON payload. */
    payload: text().notNull(),
    /** Correlation id of the goal. */
    correlation_id: text(),
    /** Event that caused this one. */
    causation_id: text(),
    /** Epoch ms created. */
    created_at: integer().notNull(),
    /** Consumer that claimed it. */
    claimed_by: text(),
    /** Epoch ms delivered (null = pending). */
    delivered_at: integer(),
    /** Times the event was delivered again after a crash. */
    redelivered: integer().notNull().default(0),
  },
  (t) => [index("thread_events_pending").on(t.thread_id, t.delivered_at, t.seq)],
);

/** Messages the thread shows (placeholders, progress, answers), ordered per thread. */
export const run_messages = sqliteTable(
  "run_messages",
  {
    /** Row id. */
    id: text().primaryKey(),
    /** Discord message id. */
    message_id: text(),
    /** Thread id. */
    thread_id: text().notNull(),
    /** Session id. */
    session_id: text(),
    /** Run id. */
    run_id: text(),
    /** Order inside the thread. */
    seq: integer().notNull(),
    /** Message kind. */
    kind: text().notNull(),
    /** Message status. */
    status: text().notNull(),
    /** Text content. */
    content: text().notNull(),
    /** Epoch ms created. */
    created_at: integer().notNull(),
    /** Task the message belongs to. */
    task_id: text(),
  },
  (t) => [index("idx_run_messages_thread").on(t.thread_id, t.seq)],
);

/** Discord message the owner was asked a question of a goal item in: a reply to it answers that item. */
export const item_questions = sqliteTable("item_questions", {
  /** Discord message id of the question. */
  message_id: text().primaryKey(),
  /** Thread the message is in. */
  thread_id: text().notNull(),
  /** Goal item the question is about. */
  item_id: text().notNull(),
  /** Epoch ms created. */
  created_at: integer().notNull(),
});
