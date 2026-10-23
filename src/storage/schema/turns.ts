import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One run of a role in a thread (a teammate call or a detached worker task). */
export const turns = sqliteTable(
  "turns",
  {
    /** Turn id. */
    id: text().primaryKey(),
    /** Thread the turn belongs to. */
    thread_id: text().notNull(),
    /** Who started it (discord, test, task, ...). */
    source: text().notNull(),
    /** Location name, or "*" until a background task names one. */
    location: text().notNull(),
    /** running, waiting_approval, done, failed, cancelled, interrupted, timeout. */
    status: text().notNull(),
    /** Epoch ms the turn started. */
    started_at: integer().notNull(),
    /** Epoch ms the turn ended (null while running). */
    ended_at: integer(),
    /** Claude session id reported at `system/init`. */
    session_id: text(),
    /** Task text of a dispatched task (stored redacted). */
    brief: text(),
    /** Role that runs the turn. */
    role: text().notNull(),
    /** Turn shape: `single` or the old `staged`. */
    kind: text().notNull().default("staged"),
    /** Turn that handed this one over, when any. */
    parent_turn_id: text(),
    /** Hand-over depth (0 = owner-started). */
    hop: integer().notNull().default(0),
    /** 1 when the turn counts against the concurrency cap. */
    counts_toward_cap: integer().notNull().default(1),
    /** Owned task row this turn works on. */
    owned_task_id: text(),
  },
  (t) => [
    index("idx_turns_thread").on(t.thread_id),
    index("idx_turns_task").on(t.owned_task_id),
    index("idx_turns_session").on(t.session_id),
    index("idx_turns_role_status").on(t.role, t.status),
    index("idx_turns_ended").on(t.ended_at),
  ],
);

/** Pending/decided tool approval of a turn (Discord buttons). */
export const approvals = sqliteTable("approvals", {
  /** Approval id. */
  id: text().primaryKey(),
  /** Turn that asked. */
  turn_id: text().notNull(),
  /** Tool name. */
  tool: text().notNull(),
  /** Short text shown to the owner. */
  summary: text().notNull(),
  /** pending, allow, deny, cancelled. */
  decision: text().notNull(),
  /** Epoch ms of the request. */
  requested_at: integer().notNull(),
  /** Epoch ms of the decision. */
  decided_at: integer(),
});
