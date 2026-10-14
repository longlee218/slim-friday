import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureParentDir, restrictFile } from "../config/workspace-paths";
import { applyLegacySchema } from "./legacy-schema";
import { isV1Db, schemaVersion, snapshotDb } from "./migrate";
import { migrateV3 } from "./migrate-v3-turns";
import { migrateV4 } from "./migrate-v4-drop-legacy-tables";
import { migrateV5 } from "./migrate-v5-thread-summaries";
import { migrateV6 } from "./migrate-v6-owned-tasks";
import { migrateV7 } from "./migrate-v7-locations-threads";

/**
 * Open (creating if needed) the SQLite db in WAL mode and migrate it to schema v7. A v1, v2, v5 or v6 db (no `meta`
 * table / marker 2 / 5 / 6) is snapshotted to `backupDir` (default `<home>/db-backups`, home = parent of the db's `data/`
 * dir) before the first change; a failed snapshot throws, so startup aborts with the db untouched.
 */
export function openDb(
  file: string,
  backupDir = join(dirname(dirname(file)), "db-backups"),
): Database {
  // ":memory:" is allowed for callers that want a throwaway db.
  const db = new Database(file === ":memory:" ? file : ensureParentDir(file), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  const version = schemaVersion(db);
  // Back up a db that already holds data (v1 = no marker + sessions table; v2 = marker 2) before any change.
  // A v3 db goes to v4 and a v4 db to v5 without a snapshot (owner decisions); a v5 db is saved before v6 and a v6 db before v7.
  const label = isV1Db(db)
    ? "v1"
    : version === 2
      ? "v2"
      : version === 5
        ? "v5"
        : version === 6
          ? "v6"
          : undefined;
  if (file !== ":memory:" && label) {
    try {
      snapshotDb(db, backupDir, label);
    } catch (err) {
      db.close(); // abort: no migration on an unsaved db
      throw new Error(`db snapshot failed, startup aborted: ${String(err)}`);
    }
  }
  try {
    // Legacy DDL uses the old names and would re-create an empty `tasks` on a v3 db: gate it by version.
    if (version < 3) applyLegacySchema(db);
    migrateV3(db);
    migrateV4(db);
    migrateV5(db);
    migrateV6(db);
    migrateV7(db);
  } catch (err) {
    // v3 to v7 are each one transaction (rolled back on error: the db stays at its last version);
    // legacy steps are additive.
    db.close();
    throw err;
  }
  if (file !== ":memory:") {
    // db holds tool output: owner-only, including the WAL/SHM sidecars created before this chmod.
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) restrictFile(f);
  }
  return db;
}
