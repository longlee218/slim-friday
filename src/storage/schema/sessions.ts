import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One saved Claude session per thread (resume target), with its cwd and compaction generation. */
export const sessions = sqliteTable("sessions", {
  /** Discord thread (or chat channel) id: one row per thread. */
  thread_id: text().primaryKey(),
  /** Claude Agent SDK session id to resume. */
  session_id: text().notNull(),
  /** Location name the session works in. */
  location: text().notNull(),
  /** Working directory of the session. */
  cwd: text().notNull(),
  /** Session status (active, expired, ...). */
  status: text().notNull(),
  /** Epoch ms of the last write. */
  updated_at: integer().notNull(),
  /** Model the session started with. */
  model: text(),
  /** Compaction cycle of the thread when the session row was created. */
  generation: integer().notNull().default(0),
  /** Session owner kind: `role` (a role run) or `teammate`. */
  kind: text().notNull().default("role"),
  /** Teammate sessions: `<compaction cycle>:<memory hash>` of the last memory block sent in this session (null = none sent). */
  memory_mark: text(),
  /** Teammate sessions: hash of the config (model, tools, skills, preset) the session started with; a changed config starts a new session. */
  config_mark: text(),
});
