import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DB_RETENTION_DAYS } from "../config/resilience-caps";
import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { oldGoalIds, pruneOldHistory } from "../storage/db-retention-store";

/* Keeps the db from growing forever: finished history older than `DB_RETENTION_DAYS` goes (see db-retention-store). */

const log = logger.child({ module: "db-retention" });

/** A goal id that is safe as a dir name (ids may be model-free uuids or test ids; nothing with a path piece). */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** How often the sweeper runs after the boot sweep. */
const SWEEP_EVERY_MS = 6 * 3_600_000;

/**
 * Prune once; logs `db.pruned` with the per-table counts when anything went. With `home`, the `task-files/<goalId>/`
 * copies of the goals about to be pruned are removed first (their messages name them; a failed removal is logged and
 * the prune goes on). Never throws.
 */
export function sweepDb(db: Database, now = Date.now(), home?: string): Record<string, number> {
  try {
    const cutoff = now - DB_RETENTION_DAYS * 86_400_000;
    if (home) removeTaskFiles(home, oldGoalIds(db, cutoff));
    const counts = pruneOldHistory(db, cutoff);
    if (Object.values(counts).some((n) => n > 0))
      logEvent(log, "db.pruned", { ...counts, days: DB_RETENTION_DAYS });
    return counts;
  } catch (err) {
    log.warn({ err: errText(err) }, "db retention sweep failed");
    return {};
  }
}

/** Remove the reported-file copies of these goals (`<home>/task-files/<goalId>`); a goal id is a uuid, anything else is skipped. */
function removeTaskFiles(home: string, goalIds: readonly string[]): void {
  const root = workspacePaths(home).taskFiles;
  for (const id of goalIds) {
    if (!SAFE_ID.test(id)) continue;
    try {
      rmSync(join(root, id), { recursive: true, force: true });
    } catch (err) {
      log.warn({ err: errText(err), goalId: id }, "task-files removal failed");
    }
  }
}

/** Sweep now (boot) and every 6 hours; the timer never keeps the process alive. Returns the stop function. */
export function startDbRetention(db: Database, home: string): () => void {
  sweepDb(db, Date.now(), home);
  const timer = setInterval(() => sweepDb(db, Date.now(), home), SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
