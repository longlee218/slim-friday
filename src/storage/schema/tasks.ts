import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** A unit of work owned by a role (a goal or an item of a goal). */
export const owned_tasks = sqliteTable(
  "owned_tasks",
  {
    /** Task id. */
    id: text().primaryKey(),
    /** Thread of the task. */
    thread_id: text().notNull(),
    /** Role that owns it. */
    owner_role: text(),
    /** Task status. */
    status: text().notNull(),
    /** Scope text. */
    scope: text().notNull().default(""),
    /** Optimistic-lock version. */
    version: integer().notNull().default(0),
    /** Correlation id of the goal. */
    correlation_id: text().notNull(),
    /** Epoch ms created. */
    created_at: integer().notNull(),
    /** Epoch ms of the last progress. */
    last_progress_at: integer().notNull(),
    /** Parent goal id (null for a goal). */
    parent_id: text(),
    /** Item key inside the goal. */
    item_key: text(),
    /** JSON array of item keys this one waits for. */
    depends_on: text().notNull().default("[]"),
    /** Attempt counter. */
    attempt: integer().notNull().default(0),
    /** How many times it was dispatched. */
    dispatch_count: integer().notNull().default(0),
    /** Location name. */
    location: text(),
    /** Task brief. */
    brief: text(),
    /** Kind of the typed result. */
    result_kind: text(),
    /** Short excerpt of the result (the full text is the task's newest `result` message). */
    result_excerpt: text(),
    /** Who may change the goal's items: `lead` (DIRECT / DELEGATE) or `plan` (PLAN). Goal rows only; null on items. */
    structure_owner: text(),
    /** Item urgency: 0 normal, 10 high, 100 urgent. The scheduler starts ready items by priority, then age; nothing is preempted. */
    priority: integer().notNull().default(0),
    /** Short label of the item (<= 80 chars) shown in lists, digests and plans; null on goals and on rows older than migration 0008 with no brief. */
    subject: text(),
  },
  (t) => [
    uniqueIndex("owned_tasks_goal_item")
      .on(t.parent_id, t.item_key)
      .where(sql`${t.parent_id} IS NOT NULL`),
    index("owned_tasks_parent").on(t.parent_id),
    index("owned_tasks_thread_progress").on(t.thread_id, t.last_progress_at),
  ],
);
