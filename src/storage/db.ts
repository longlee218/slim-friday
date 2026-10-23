import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { ensureParentDir, restrictFile } from "../config/workspace-paths";
import { probeFts5 } from "./fts-probe";

/** Generated SQL migrations, resolved from this file (never from the cwd) so any start directory finds them. */
const MIGRATIONS_FOLDER = join(import.meta.dir, "migrations");

/** Drizzle's migration log table: its presence marks a database this binary created. */
const MIGRATIONS_TABLE = "__drizzle_migrations";

/** True when the db already holds user tables (not sqlite internals). */
function hasUserTables(db: Database): boolean {
  return (
    // biome-ignore lint/style/noNonNullAssertion: COUNT always returns a row
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .get()!.n > 0
  );
}

/** True when the db has the Drizzle migration log table. */
function hasMigrationsTable(db: Database): boolean {
  return !!db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
}

/**
 * Open (creating if needed) the SQLite db in WAL mode and apply the Drizzle migrations (a baseline plus the FTS5
 * `memory_fts` table). Reopening an up-to-date db is a no-op. A db with tables but no migration log (an old Friday
 * schema or a foreign file) is refused: there is no upgrade path, the owner starts over.
 */
export function openDb(file: string): Database {
  // ":memory:" is allowed for callers that want a throwaway db.
  const db = new Database(file === ":memory:" ? file : ensureParentDir(file), { create: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    probeFts5(db);
    if (hasUserTables(db) && !hasMigrationsTable(db))
      throw new Error(
        `database ${file} is not a Friday baseline database: stop the bot, delete it and <AGENT_HOME> (see docs/discord-setup.md) and start again`,
      );
    migrate(drizzle({ client: db }), { migrationsFolder: MIGRATIONS_FOLDER });
  } catch (err) {
    db.close();
    throw err;
  }
  if (file !== ":memory:") {
    // db holds tool output: owner-only, including the WAL/SHM sidecars created before this chmod.
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) restrictFile(f);
  }
  return db;
}
