import type { Database } from "bun:sqlite";

/** Tokenizer of the `memory_fts` index (folds diacritics). The migration `0001_memory_fts.sql` holds the same text literally. */
export const FTS_TOKENIZER = "unicode61 remove_diacritics 2";

/** Temp table used only by the startup probe. */
const FTS_PROBE_TABLE = "temp.fts5_probe";

/** Startup error text when the SQLite build cannot host the memory index. */
const FTS_MISSING_MESSAGE =
  "this Bun SQLite build lacks FTS5 or the 'remove_diacritics 2' tokenizer option; upgrade Bun or call Database.setCustomSQLite";

/** Error text without nested "Error:" prefixes. */
const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Throw a clear error when FTS5 or the tokenizer option is unavailable. Uses a temp table, dropped at once.
 * No silent degraded mode: the bot must refuse to start.
 */
export function probeFts5(db: Database): void {
  try {
    db.exec(`CREATE VIRTUAL TABLE ${FTS_PROBE_TABLE} USING fts5(x, tokenize = '${FTS_TOKENIZER}')`);
    db.exec(`DROP TABLE ${FTS_PROBE_TABLE}`);
  } catch (err) {
    throw new Error(`${FTS_MISSING_MESSAGE} (${msgOf(err)})`);
  }
}
