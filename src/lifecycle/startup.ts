import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_NAME, workspacePaths } from "../config/workspace-paths";
import { cleanupAttachments } from "../ingress/attachment-summary";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { sweepStalePlugins } from "../runtime/skills-plugin/plugin-sweep";
import { purgeRunMessages } from "../storage/run-message-store";
import { setTurnStatus } from "../storage/run-store";

/** Raw per-task logs older than this are deleted at startup. */
export const LOG_RETENTION_DAYS = 30;

/** A `failed_resumable` task nobody continued for this long loses its saved plan and becomes `failed`. */
export const HELD_TASK_DAYS = 14;

/** Task ids are uuids: only such an id is turned into a path. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const log = logger.child({ module: "startup" });

/** Delete `*.jsonl` files of `dir` last modified before `cutoff` (epoch ms); returns how many. */
function deleteOldJsonl(dir: string, cutoff: number): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, e.name);
    // Regular files only: a directory named *.jsonl must not abort the run.
    if (!e.isFile() || !e.name.endsWith(".jsonl") || statSync(file).mtimeMs >= cutoff) continue;
    rmSync(file, { force: true });
    n++;
  }
  return n;
}

/** Delete raw per-task logs (`logs/tasks/*.jsonl`) older than the retention. */
export function cleanupTaskLogs(agentHome: string, now = Date.now()): number {
  const paths = workspacePaths(agentHome);
  const cutoff = now - LOG_RETENTION_DAYS * 86_400_000;
  const deleted = deleteOldJsonl(join(paths.home, "logs", "tasks"), cutoff);
  if (deleted) logEvent(log, "logs.cleaned", { deleted, days: LOG_RETENTION_DAYS });
  return deleted;
}

/**
 * Held tasks (`failed_resumable`, waiting for a `/go`) older than the retention expire by age: the saved plan dir is
 * removed and the task becomes `failed`, so `/go` has nothing to continue. Returns the expired task ids.
 */
export function expireHeldTasks(
  db: Database,
  agentHome: string,
  now = Date.now(),
  /** Directory remover (tests inject a failing one). */
  removeDir: (dir: string) => void = (dir) => rmSync(dir, { recursive: true, force: true }),
): string[] {
  const cutoff = now - HELD_TASK_DAYS * 86_400_000;
  const ids = db
    .query<{ id: string }, [number]>(
      "SELECT id FROM turns WHERE status = 'failed_resumable' AND COALESCE(ended_at, started_at) < ?",
    )
    .all(cutoff)
    .map((r) => r.id);
  const ws = workspacePaths(agentHome);
  const names = existsSync(ws.workspaces) ? readdirSync(ws.workspaces) : [];
  for (const id of ids) {
    // `failed` first: a failing rm (EACCES) must not keep the task held, nor abort the loop, nor be retried forever.
    setTurnStatus(db, id, "failed");
    try {
      // The task dir is rebuilt from validated names and a uuid, never taken from a row as a path.
      if (UUID_RE.test(id))
        for (const name of names.filter((n) => WORKSPACE_NAME.test(n)))
          removeDir(ws.workspace(name).task(id).root);
      logEvent(log, "hold.expired", { taskId: id });
    } catch (err) {
      log.warn({ taskId: id, err: errText(err) }, "held task plan dir not removed");
    }
  }
  return ids;
}

/** Startup hygiene: log retention + stale plugin dirs + held-task expiry + attachments + owner-message purge. Never throws (best effort). */
export async function runStartupHygiene(db: Database, agentHome: string): Promise<void> {
  try {
    cleanupTaskLogs(agentHome);
    sweepStalePlugins(agentHome);
    expireHeldTasks(db, agentHome);
    cleanupAttachments(agentHome);
    const purged = purgeRunMessages(db); // owner messages kept for the audit (Rev 11) age out too
    if (purged) logEvent(log, "run_messages.purged", { deleted: purged });
  } catch (err) {
    log.warn({ err: String(err) }, "startup hygiene failed");
  }
}
