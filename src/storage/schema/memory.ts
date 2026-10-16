import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Ledger of memory files already indexed (mtime/size tell a re-index is due). The `memory_fts` FTS5 table is created
 * by the custom migration `memory_fts` (drizzle has no FTS5 support), not declared here.
 */
export const memory_files = sqliteTable("memory_files", {
  /** Absolute file path. */
  path: text().primaryKey(),
  /** Workspace the file belongs to. */
  workspace: text().notNull(),
  /** File mtime in ms when indexed. */
  mtime_ms: integer().notNull(),
  /** File size when indexed. */
  size: integer().notNull(),
});
