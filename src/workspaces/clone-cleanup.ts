import type { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { REPO_NAME, WORKSPACE_NAME, workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { runGit } from "../repos/git-cli";
import { dropResumable } from "../storage/run-store";
import { deleteSession } from "../storage/session-store";
import { deleteWorktree, getWorktreeByThread, type WorktreeRow } from "../storage/worktree-store";
import { resolveCleanupTarget } from "./clone-lookup";
import { safeRemoveClone, TASK_BRANCH_RE, UUID_RE } from "./clone-safety";

const log = logger.child({ module: "clone-cleanup" });

/** Branch a legacy worktree row may have: `agent/*` (old worktrees) or `friday/*`. Never `main`, never a `-` option. */
const LEGACY_BRANCH_RE = /^(agent|friday)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/**
 * Remove the directory of a task clone (row with `base_sha`). The target is rebuilt from the validated
 * workspace, repo and task id; the row's own `path` is only compared with it. Returns false when refused.
 */
export function removeCloneDir(wt: WorktreeRow, agentHome: string): boolean {
  // Names are validated first: a tampered `..` would widen the removal root.
  if (!wt.workspace || !WORKSPACE_NAME.test(wt.workspace) || !REPO_NAME.test(wt.repo)) return false;
  if (!UUID_RE.test(wt.taskId)) return false;
  const root = workspacePaths(agentHome).workspace(wt.workspace).repo(wt.repo).worktrees;
  const target = join(root, wt.taskId);
  if (resolve(wt.path) !== target) {
    log.warn({ taskId: wt.taskId }, "clone.remove_refused: row path differs from the rebuilt one");
    return false;
  }
  const ok = safeRemoveClone(target, root);
  if (!ok) logEvent(log, "clone.remove_refused", { taskId: wt.taskId }, "warn");
  return ok;
}

/** Remove a task's checkout. A clone is a plain directory; a legacy row (no `base_sha`) is a git worktree of the owner repo. */
async function removeCheckout(wt: WorktreeRow, agentHome: string): Promise<boolean> {
  if (wt.baseSha !== null) return removeCloneDir(wt, agentHome);
  await removeLegacyWorktree(wt);
  return true;
}

/** Unregister a legacy `git worktree` row from the owner repo, then drop its local branch. Best effort. */
export async function removeLegacyWorktree(wt: WorktreeRow): Promise<void> {
  await runGit(["worktree", "remove", "--force", wt.path], wt.repoPath).catch(() => undefined);
  // `--` ends options; the branch shape check keeps a tampered row from deleting an owner branch.
  if (LEGACY_BRANCH_RE.test(wt.branch) || TASK_BRANCH_RE.test(wt.branch))
    await runGit(["branch", "-D", "--", wt.branch], wt.repoPath).catch(() => undefined);
}

/** Remove a clone row's checkout, then the row and its session. False when the removal was refused (row kept). */
export async function dropClone(
  db: Database,
  agentHome: string,
  wt: WorktreeRow,
): Promise<boolean> {
  if (!(await removeCheckout(wt, agentHome))) return false;
  deleteWorktree(db, wt.taskId);
  deleteSession(db, wt.threadId);
  dropResumable(db, wt.threadId); // nothing left to resume: a held `failed_resumable` task becomes `failed`
  return true;
}

/** Where `/cleanup` was typed: the thread and its channel (the channel names the workspace). */
export interface CleanupWhere {
  threadId: string;
  channelId: string;
}

/**
 * `/cleanup` removes a task checkout + its row + its session: this thread's, or `<taskId8|taskId>` of this
 * workspace. Returns the reply.
 */
export async function cleanupWorktree(
  deps: { db: Database; agentHome: string; active: ReadonlyMap<string, unknown> },
  where: CleanupWhere,
  arg?: string,
): Promise<string> {
  const { db } = deps;
  let wt: WorktreeRow | null;
  if (arg) {
    const hit = resolveCleanupTarget(deps, where.channelId, arg);
    if (typeof hit === "string") return hit;
    wt = hit;
  } else wt = getWorktreeByThread(db, where.threadId);
  if (!wt)
    // A held task that never got a clone (no commit identity) has nothing to remove: `/cleanup` just drops the hold.
    return !arg && dropResumable(db, where.threadId)
      ? "Dropped the held task (no clone was made)."
      : "No task clone found to clean up.";
  if (deps.active.has(wt.threadId)) return "That task clone is in use by a running task.";
  try {
    if (!(await dropClone(db, deps.agentHome, wt)))
      return "Refused: the clone row is invalid or its path is outside the task clones dir.";
  } catch (err) {
    log.error({ err: errText(err) }, "cleanup failed");
    return "Agent failed. Check the logs.";
  }
  logEvent(log, "clone.removed", { repo: wt.repo, branch: wt.branch });
  return `Removed the task clone and its branch ${wt.branch} (uncommitted or unpushed work is gone).`;
}
