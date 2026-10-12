import type { Database } from "bun:sqlite";
import { logEvent, logger } from "../observability/logger";
import { countOf, hasTable, KEPT_TABLES, schemaVersion } from "./migrate";
import {
  FTS_TOKENIZER,
  MEMORY_FILES_DDL,
  MEMORY_FTS_DDL,
  THREAD_SUMMARIES_DDL,
} from "./migrate-v5-ddl";

const log = logger.child({ module: "db-migrate" });

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

/**
 * Schema v5: add `thread_summaries` (summary store) and the memory index tables `memory_fts` + `memory_files`.
 * Purely additive. ONE transaction: any throw (a clash with an existing table, a count mismatch) rolls
 * everything back, virtual tables included, and the db stays v4; `schema_version` is written last.
 * No-op when the db is already v5. No snapshot (additive; owner decision). `probe` is injectable for tests.
 */
export function migrateV5(db: Database, probe: (db: Database) => void = probeFts5): void {
  if (schemaVersion(db) >= 5) return;
  try {
    probe(db); // before any DDL, outside the transaction
    db.transaction(() => {
      const kept = KEPT_TABLES.filter((t) => hasTable(db, t));
      const before = kept.map((t) => countOf(db, t));
      // Plain CREATE (no IF NOT EXISTS): a pre-existing table of the same name is a clash, not data to trust.
      db.exec(THREAD_SUMMARIES_DDL);
      db.exec(MEMORY_FTS_DDL);
      db.exec(MEMORY_FILES_DDL);
      kept.forEach((t, i) => {
        if (countOf(db, t) !== before[i])
          throw new Error(
            `v5 migration: row count of ${t} changed (${before[i]} -> ${countOf(db, t)})`,
          );
      });
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')").run();
    })();
  } catch (err) {
    log.error({ err: msgOf(err) }, "db.migrate.failed");
    throw new Error(`v5 migration failed, the db stays at v4: ${msgOf(err)}`);
  }
  logEvent(log, "db.migrated", {
    from: 4,
    to: 5,
    added: ["thread_summaries", "memory_fts", "memory_files"],
  });
}
