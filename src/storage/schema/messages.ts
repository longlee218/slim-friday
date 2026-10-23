import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Messages between the lead and a worker, attached to a task (append-only; read scope = the thread). */
export const task_messages = sqliteTable(
  "task_messages",
  {
    /** Message id (shown to agents as `M<id>`); one sequence per database. */
    id: integer().primaryKey({ autoIncrement: true }),
    /** Thread of the task (read scope). */
    thread_id: text().notNull(),
    /** Goal of the task. */
    goal_id: text().notNull(),
    /** Item the message belongs to. */
    task_id: text().notNull(),
    /** Who wrote it: `lead`, a role name, `system` (code) or `owner` (an owner reply the lead relayed). */
    author: text().notNull(),
    /** `brief`, `steer`, `question`, `answer`, `note`, `progress`, `blocker` or `result`. */
    kind: text().notNull(),
    /** Id of the message this one answers (question to answer); null otherwise. */
    reply_to: integer(),
    /** Full text, redacted, never cut. */
    text: text().notNull(),
    /** JSON `{title, base, path}[]` deliverables (a result only); null otherwise. */
    files: text(),
    /** Epoch ms created. */
    created_at: integer().notNull(),
  },
  (t) => [
    index("task_messages_task").on(t.task_id, t.id),
    index("task_messages_thread").on(t.thread_id, t.id),
  ],
);
