/** Tokenizer of the memory index: case-folded, accents stripped (needs SQLite >= 3.27). */
export const FTS_TOKENIZER = "unicode61 remove_diacritics 2";

/** Table of the per-thread summary that outlives the `sessions` row. */
export const THREAD_SUMMARIES_DDL = `CREATE TABLE thread_summaries (
  thread_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  rolled_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  cycle INTEGER NOT NULL DEFAULT 0,
  flushed_cycle INTEGER NOT NULL DEFAULT -1
)`;

/**
 * Memory search index (derived data, rebuildable from the files + `thread_summaries`).
 * Only `text` is searchable; the other columns ride along. `workspace` is '' for root rows.
 */
export const MEMORY_FTS_DDL = `CREATE VIRTUAL TABLE memory_fts USING fts5(
  text, id UNINDEXED, source UNINDEXED, section UNINDEXED, kind UNINDEXED,
  date UNINDEXED, workspace UNINDEXED, path UNINDEXED,
  tokenize = '${FTS_TOKENIZER}'
)`;

/** Freshness ledger of the index: a file path, or pseudo path `summary/<threadId>` (mtime = updated_at, size = cycle). */
export const MEMORY_FILES_DDL = `CREATE TABLE memory_files (
  path TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL
)`;
