import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { deleteSession } from "../storage/session-store";
import { deleteWorktree, listWorktrees, type WorktreeRow } from "../storage/worktree-store";
import { removeCloneDir } from "../workspaces/clone-cleanup";

/* Startup retention of task clones: a delivered or kept clone is removed after CLONE_RETENTION_DAYS. */

const log = logger.child({ module: "clone-retention" });

/** Default retention (days) when the config does not give one. */
export const DEFAULT_CLONE_RETENTION_DAYS = 14;
/** Milliseconds in a day. */
export const DAY_MS = 86_400_000;

/**
 * Last activity of a clone: the latest of delivery, creation and the start/end of any task of its thread
 * (every follow-up message is a task row), so a kept clone the owner still works in does not age out.
 */
function lastActivity(db: Database, w: WorktreeRow): number {
  const t = db
    .query(
      "SELECT MAX(MAX(started_at), COALESCE(MAX(ended_at), 0)) AS last FROM tasks WHERE thread_id = ?",
    )
    .get(w.threadId) as { last: number | null } | null;
  return Math.max(w.deliveredAt ?? 0, w.createdAt, t?.last ?? 0);
}

/**
 * Remove delivered|kept clones idle longer than the retention (age from last activity; active clones are never touched): the clone dir
 * (safe remove only), its patch file, the row and the session. A refused removal keeps the row. Returns the task ids removed.
 */
export function expireClones(
  db: Database,
  agentHome: string,
  retentionDays = DEFAULT_CLONE_RETENTION_DAYS,
  now = Date.now(),
): string[] {
  const cutoff = now - retentionDays * DAY_MS;
  const removed: string[] = [];
  for (const w of listWorktrees(db)) {
    if (w.baseSha === null || (w.status !== "delivered" && w.status !== "kept")) continue;
    if (lastActivity(db, w) >= cutoff) continue;
    if (!removeCloneDir(w, agentHome)) continue; // refused: logged by the safe remove, row stays
    // The patch path is rebuilt from validated ids (removeCloneDir accepted them), never read from the row.
    const taskDir = workspacePaths(agentHome)
      .workspace(w.workspace as string)
      .task(w.taskId).root;
    rmSync(join(taskDir, `${w.taskId.slice(0, 8)}.patch`), { force: true });
    deleteWorktree(db, w.taskId);
    deleteSession(db, w.threadId);
    removed.push(w.taskId);
    logEvent(log, "clone.expired", { repo: w.repo, branch: w.branch, status: w.status });
  }
  return removed;
}
