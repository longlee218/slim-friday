import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/** Generated SQL migrations, resolved from this file so any start directory finds them. */
const MIGRATIONS_FOLDER = join(import.meta.dir, "migrations");
/** Drizzle's migration log table: its presence marks a db this package created. */
const MIGRATIONS_TABLE = "__drizzle_migrations";

/** True when the db holds user tables (not sqlite internals). */
function hasUserTables(db: Database): boolean {
  const row = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .get();
  return (row?.n ?? 0) > 0;
}

/** True when the db has the Drizzle migration log table. */
function hasMigrationsTable(db: Database): boolean {
  return !!db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
}

/**
 * Open (creating if needed) the engine db in WAL mode and apply the migrations. A db that has tables but no
 * migration log (a foreign file or an old schema) is refused and left untouched. The file and its WAL / SHM
 * sidecars are owner-only. `":memory:"` gives a throwaway db.
 */
export function openEngineDb(file: string): Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    if (hasUserTables(db) && !hasMigrationsTable(db))
      throw new Error(`database ${file} is not an engine database: move it away and start again`);
    migrate(drizzle({ client: db }), { migrationsFolder: MIGRATIONS_FOLDER });
  } catch (err) {
    db.close();
    throw err;
  }
  if (file !== ":memory:")
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  return db;
}
