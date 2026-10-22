import type { Database } from "bun:sqlite";
import { DB_RETENTION_DAYS } from "../config/resilience-caps";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { pruneOldHistory } from "../storage/db-retention-store";

/* Keeps the db from growing forever: finished history older than `DB_RETENTION_DAYS` goes (see db-retention-store). */

const log = logger.child({ module: "db-retention" });

/** How often the sweeper runs after the boot sweep. */
const SWEEP_EVERY_MS = 6 * 3_600_000;

/** Prune once; logs `db.pruned` with the per-table counts when anything went. Never throws. */
export function sweepDb(db: Database, now = Date.now()): Record<string, number> {
  try {
    const counts = pruneOldHistory(db, now - DB_RETENTION_DAYS * 86_400_000);
    if (Object.values(counts).some((n) => n > 0))
      logEvent(log, "db.pruned", { ...counts, days: DB_RETENTION_DAYS });
    return counts;
  } catch (err) {
    log.warn({ err: errText(err) }, "db retention sweep failed");
    return {};
  }
}

/** Sweep now (boot) and every 6 hours; the timer never keeps the process alive. Returns the stop function. */
export function startDbRetention(db: Database): () => void {
  sweepDb(db);
  const timer = setInterval(() => sweepDb(db), SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
