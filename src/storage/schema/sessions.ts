import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One saved Claude session per thread (resume target), with its cwd and rollover generation. */
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
  /** Rollover counter: bumped each time the session is replaced by a fresh one. */
  generation: integer().notNull().default(0),
  /** Session owner kind: `role` (a role run) or `lead`. */
  kind: text().notNull().default("role"),
});
