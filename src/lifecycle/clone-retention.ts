import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { REPO_NAME, WORKSPACE_NAME, workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { dropResumable, setTaskStatus } from "../storage/run-store";
import { deleteSession } from "../storage/session-store";
import { deleteWorktree, listWorktrees, type WorktreeRow } from "../storage/worktree-store";
import { removeCloneDir, removeLegacyWorktree } from "../workspaces/clone-cleanup";
import { UUID_RE } from "../workspaces/clone-safety";

/* Startup retention of task clones: a delivered or kept clone is removed after CLONE_RETENTION_DAYS.
   Legacy pre-P2.1 git-worktree rows (no base_sha) expire on the same age rule. */

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
 * An `active` clone is held for a resume (Rev 12): its task, or a resumed run of it, is `failed_resumable`. It
 * expires like a kept one, also after a newer task of the thread started (no clone stays `active` forever).
 */
function heldForResume(db: Database, w: WorktreeRow): boolean {
  return (
    w.status === "active" &&
    !!db
      .query(
        "SELECT 1 FROM tasks WHERE status = 'failed_resumable' AND thread_id = ? AND (id = ? OR parent_task_id = ?) LIMIT 1",
      )
      .get(w.threadId, w.taskId, w.taskId)
  );
}

/** A `failed_resumable` task that never got a clone (no commit identity): its saved plan is all it holds. */
function expireClonelessHolds(db: Database, agentHome: string, cutoff: number): string[] {
  const rows = db
    .query<{ id: string }, [number]>(
      `SELECT t.id FROM tasks t WHERE t.status = 'failed_resumable'
         AND COALESCE(t.ended_at, t.started_at) < ?
         AND NOT EXISTS (SELECT 1 FROM worktrees w WHERE w.task_id = t.id OR w.task_id = t.parent_task_id)`,
    )
    .all(cutoff);
  const ws = workspacePaths(agentHome);
  const names = existsSync(ws.workspaces) ? readdirSync(ws.workspaces) : [];
  for (const { id } of rows) {
    // The task dir (saved plan) is rebuilt from validated names and a uuid, never taken from a row.
    if (UUID_RE.test(id))
      for (const name of names.filter((n) => WORKSPACE_NAME.test(n)))
        rmSync(ws.workspace(name).task(id).root, { recursive: true, force: true });
    setTaskStatus(db, id, "failed");
    logEvent(log, "hold.expired", { taskId: id });
  }
  return rows.map((r) => r.id);
}

/**
 * Remove delivered|kept clones, and clones held for a resume, idle longer than the retention (age from last activity; other active clones are never touched): the clone dir
 * (safe remove only), its patch file, the row and the session. A refused removal keeps the row. Held tasks without a clone
 * expire by task age (plan file removed, task `failed`). Returns the task ids removed.
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
    if (w.baseSha === null) continue;
    if (w.status !== "delivered" && w.status !== "kept" && !heldForResume(db, w)) continue;
    if (lastActivity(db, w) >= cutoff) continue;
    if (!removeCloneDir(w, agentHome)) continue; // refused: logged by the safe remove, row stays
    // The patch path is rebuilt from validated ids (removeCloneDir accepted them), never read from the row.
    const taskDir = workspacePaths(agentHome)
      .workspace(w.workspace as string)
      .task(w.taskId).root;
    rmSync(join(taskDir, `${w.taskId.slice(0, 8)}.patch`), { force: true });
    deleteWorktree(db, w.taskId);
    deleteSession(db, w.threadId);
    dropResumable(db, w.threadId); // nothing left to resume: the held task becomes `failed`
    removed.push(w.taskId);
    logEvent(log, "clone.expired", { repo: w.repo, branch: w.branch, status: w.status });
  }
  removed.push(...expireClonelessHolds(db, agentHome, cutoff));
  return removed;
}

/**
 * True when `path` is exactly `<home>/workspaces/<ws>/repos/<repo>/worktrees/<id>` (names validated, not a symlink):
 * the only place a legacy worktree may be removed from. Anything else is refused.
 */
function inExpectedWorktreesDir(agentHome: string, path: string): boolean {
  const parts = relative(workspacePaths(agentHome).workspaces, resolve(path)).split(sep);
  const [ws, repos, repo, wts, id] = parts;
  if (parts.length !== 5 || repos !== "repos" || wts !== "worktrees" || !id) return false;
  if (!WORKSPACE_NAME.test(ws as string) || !REPO_NAME.test(repo as string)) return false;
  try {
    return !lstatSync(path).isSymbolicLink();
  } catch {
    return true; // dir already gone: only git's registration is left to prune
  }
}

/**
 * Remove legacy worktree rows (`base_sha` null, registered in the owner repo) idle longer than the retention, of any
 * status: migrated rows all read `active`, so the status cannot tell them apart; age from last activity does.
 * Removal is `git worktree remove` + `branch -D --` (agent/*|friday/* only) via the legacy cleanup path, and only
 * inside the expected worktrees dir. A refused or failed row stays and is retried next start. Not counted in the
 * kept-clones cap (that cap only lists clones). Returns the task ids removed.
 */
export async function expireLegacyWorktrees(
  db: Database,
  agentHome: string,
  retentionDays = DEFAULT_CLONE_RETENTION_DAYS,
  now = Date.now(),
): Promise<string[]> {
  const cutoff = now - retentionDays * DAY_MS;
  const removed: string[] = [];
  for (const w of listWorktrees(db)) {
    if (w.baseSha !== null || lastActivity(db, w) >= cutoff) continue;
    try {
      if (!inExpectedWorktreesDir(agentHome, w.path)) {
        logEvent(log, "worktree.expire_refused", { taskId: w.taskId }, "warn");
        continue;
      }
      await removeLegacyWorktree(w);
      deleteWorktree(db, w.taskId);
      deleteSession(db, w.threadId);
      removed.push(w.taskId);
      logEvent(log, "worktree.expired", { repo: w.repo, branch: w.branch, status: w.status });
    } catch (err) {
      log.warn({ taskId: w.taskId, err: String(err) }, "legacy worktree expiry failed");
    }
  }
  return removed;
}
