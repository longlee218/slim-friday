import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

/**
 * Ledger of journal bullets that dreaming already consumed (journal files are never rewritten). `hash` = first 16 hex
 * chars of sha1 over the normalized bullet text; rows older than the journal retention are pruned.
 */
export const memory_promotions = sqliteTable(
  "memory_promotions",
  {
    workspace: text().notNull(),
    channel: text().notNull(),
    hash: text().notNull(),
    /** When the bullet was consumed (epoch ms). */
    promoted_at: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace, t.channel, t.hash] })],
);
