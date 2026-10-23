import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Friday's home: AGENT_HOME, else ~/.friday (logs, persona files, workspaces are read from here). */
export const AGENT_HOME = process.env.AGENT_HOME ?? join(homedir(), ".friday");

/** Friday's db: DASHBOARD_DB, else <AGENT_HOME>/data/agent.db. */
export const DB_PATH = process.env.DASHBOARD_DB ?? join(AGENT_HOME, "data", "agent.db");

/**
 * Read-only handle: the dashboard never writes. WAL lets it read while the bot writes;
 * busy_timeout covers a checkpoint in progress.
 */
export function openReadOnly(): Database {
  if (!existsSync(DB_PATH)) throw new Error(`Friday db not found at ${DB_PATH} (set DASHBOARD_DB)`);
  const db = new Database(DB_PATH, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

/** Runs started before the own-cost fix (commit 2e1a8fb) store the SDK session total, not the run's own cost. */
const OWN_COST_SINCE_MS = Date.parse("2026-10-22T18:31:16+07:00");

/** True while the db still holds runs from before the own-cost fix, so teammate cost sums read high (they age out with the db retention). */
export function teammateCostIsCumulative(db: Database): boolean {
  return (
    db
      .query("SELECT 1 FROM runs r JOIN turns t ON t.id = r.turn_id WHERE t.started_at < ? LIMIT 1")
      .get(OWN_COST_SINCE_MS) != null
  );
}
