import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { restrictFile } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";

const log = logger.child({ module: "db-migrate" });

/** True when the table exists. */
export const hasTable = (db: Database, name: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** Data tables that survive every migration step: their row counts must be unchanged by additive/drop steps. */
export const KEPT_TABLES = [
  "turns",
  "runs",
  "approvals",
  "tool_calls",
  "proposals",
  "run_messages",
  "sessions",
] as const;

/** Row count of a table (table name is app-built, never owner text). */
export const countOf = (db: Database, table: string): number =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;

/** True when the db is a v1 one: it has data tables but no `meta` marker yet (a fresh db has neither). */
export function isV1Db(db: Database): boolean {
  return hasTable(db, "sessions") && !hasTable(db, "meta");
}

/** Stored schema version; 0 = no marker (fresh db or v1). */
export function schemaVersion(db: Database): number {
  if (!hasTable(db, "meta")) return 0;
  const row = db
    .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  return row ? Number(row.value) : 0;
}

/**
 * Write a consistent copy of the db to `<backupDir>/friday-<label>-<ts>.db` (`VACUUM INTO`, safe with WAL);
 * `label` is the version the copy holds (`v1`, `v2`, `v5`, `v6`, `v7`). Throws on failure: the caller must then abort startup,
 * no migration runs on an unsaved db.
 */
export function snapshotDb(
  db: Database,
  backupDir: string,
  label: "v1" | "v2" | "v5" | "v6" | "v7",
  now = new Date(),
): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const target = join(backupDir, `friday-${label}-${ts}.db`);
  // The path is app-built (no owner text); single quotes are doubled anyway as the SQL literal requires.
  db.run(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  restrictFile(target); // holds tool output like the live db: owner-only
  logEvent(log, "db.snapshot", { path: target });
  return target;
}
