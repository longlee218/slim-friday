import type { Database } from "bun:sqlite";
import { REPO_NAME, WORKSPACE_NAME, workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { runGit } from "../repos/git-cli";
import { deleteSession } from "../storage/session-store";
import {
  deleteWorktree,
  getWorktreeByTask,
  getWorktreeByThread,
  type WorktreeRow,
} from "../storage/worktree-store";
import { safeRemoveClone, TASK_BRANCH_RE } from "./clone-safety";

const log = logger.child({ module: "clone-cleanup" });

/** Branch a legacy worktree row may have: `agent/*` (old worktrees) or `friday/*`. Never `main`, never a `-` option. */
const LEGACY_BRANCH_RE = /^(agent|friday)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** Remove a task's checkout. A clone is a plain directory; a legacy row (no `base_sha`) is a git worktree of the owner repo. */
async function removeCheckout(wt: WorktreeRow, agentHome: string): Promise<boolean> {
  if (wt.baseSha !== null) {
    // The removal root is derived from the row's workspace + repo, never from its own path: a bad row cannot widen it.
    // Both names are validated first: a tampered `..` would widen the root.
    if (!wt.workspace || !WORKSPACE_NAME.test(wt.workspace) || !REPO_NAME.test(wt.repo))
      return false;
    const root = workspacePaths(agentHome).workspace(wt.workspace).repo(wt.repo).worktrees;
    return safeRemoveClone(wt.path, root);
  }
  // Legacy `git worktree` row: unregister it from the owner repo, then drop its local branch. Best effort.
  await runGit(["worktree", "remove", "--force", wt.path], wt.repoPath).catch(() => undefined);
  // `--` ends options; the branch shape check keeps a tampered row from deleting an owner branch.
  if (LEGACY_BRANCH_RE.test(wt.branch) || TASK_BRANCH_RE.test(wt.branch))
    await runGit(["branch", "-D", "--", wt.branch], wt.repoPath).catch(() => undefined);
  return true;
}

/** `/cleanup` removes a task checkout + its row + its session: this thread's, or a task's by id. Returns the reply. */
export async function cleanupWorktree(
  deps: { db: Database; agentHome: string; active: ReadonlyMap<string, unknown> },
  threadId: string,
  taskId?: string,
): Promise<string> {
  const { db } = deps;
  const wt = taskId ? getWorktreeByTask(db, taskId) : getWorktreeByThread(db, threadId);
  if (!wt) return "No task clone found to clean up.";
  if (deps.active.has(wt.threadId)) return "That task clone is in use by a running task.";
  try {
    if (!(await removeCheckout(wt, deps.agentHome)))
      return "Refused: the clone row is invalid or its path is outside the task clones dir.";
    deleteWorktree(db, wt.taskId);
    deleteSession(db, wt.threadId);
  } catch (err) {
    log.error({ err: errText(err) }, "cleanup failed");
    return "Agent failed. Check the logs.";
  }
  logEvent(log, "clone.removed", { repo: wt.repo, branch: wt.branch });
  return `Removed the task clone and its branch ${wt.branch} (uncommitted or unpushed work is gone).`;
}
