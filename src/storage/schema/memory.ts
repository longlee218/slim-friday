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

/**
 * Audit of the lead's memory writes (`MemorySave`, `MemoryEdit`): who changed what, never the text. `hash` = first 16 hex
 * chars of sha1 over the normalized bullet (the dream ledger's hash), so a row can be matched to a bullet without
 * storing it. For `edit_replace` the hash is the NEW bullet's (`old_hash` holds the replaced one), for `edit_delete` the deleted one's. No retention limit.
 */
export const memory_audit = sqliteTable("memory_audit", {
  id: integer().primaryKey({ autoIncrement: true }),
  /** When the write happened (epoch ms). */
  ts: integer().notNull(),
  /** Thread of the run ('' when the run had none). */
  thread_id: text().notNull(),
  /** Channel (yaml name) whose memory changed. */
  channel: text().notNull(),
  /** Role of the run that wrote (the lead). */
  role: text().notNull(),
  /** `save` | `edit_delete` | `edit_replace`. */
  action: text().notNull(),
  /** `channel` | `journal`. */
  scope: text().notNull(),
  /** Bullet hash (see above). */
  hash: text().notNull(),
  /** `edit_replace` only: hash of the replaced (old) bullet; null for every other row. */
  old_hash: text(),
});
