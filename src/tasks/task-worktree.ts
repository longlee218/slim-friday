import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import type { GitMcp } from "../mcp/git-mcp";
import { GIT_TOOL } from "../mcp/mcp-tool-names";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import type { Repo } from "../repos/repo-registry";
import { deleteSession } from "../storage/session-store";
import {
  deleteWorktree,
  getWorktreeByTask,
  getWorktreeByThread,
  insertWorktree,
  type WorktreeRow,
} from "../storage/worktree-store";
import type { CodeFlowDeps, CodeFlowInput } from "./code-task-flow";
import { type FlowResult, failResult, OUTCOME_REPLY } from "./task-result";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "task-worktree" });

/* Everything about a task's git worktree, all through the git MCP server: create, stage switch, remove. */

/** Create a task worktree on a NEW branch cut from the repo's base branch. Throws when it cannot be created. */
export async function createTaskWorktree(
  git: GitMcp,
  o: { repoPath: string; worktreePath: string; branch: string; base: string },
): Promise<void> {
  mkdirSync(dirname(o.worktreePath), { recursive: true });
  // Fetch first so the branch starts from the latest remote base (a repo without a remote is fine).
  await git.call(GIT_TOOL.FETCH, { path: o.repoPath, remote: "origin" }).catch(() => undefined);
  const add = (commitish: string) =>
    git.call(GIT_TOOL.WORKTREE, {
      path: o.repoPath,
      mode: "add",
      worktreePath: o.worktreePath,
      branch: o.branch,
      commitish,
    });
  await add(`origin/${o.base}`).catch(() => add(o.base));
}

/** Remove a worktree and its local branch (unpushed commits are lost). Best effort: failures are ignored. */
export async function removeTaskWorktree(
  git: GitMcp,
  wt: { repoPath: string; path: string; branch: string; repo?: string },
): Promise<void> {
  await git
    .call(GIT_TOOL.WORKTREE, {
      path: wt.repoPath,
      mode: "remove",
      worktreePath: wt.path,
      force: true,
    })
    .catch(() => undefined);
  await git
    .call(GIT_TOOL.BRANCH, {
      path: wt.repoPath,
      mode: "delete",
      branchName: wt.branch,
      force: true,
    })
    .catch(() => undefined);
  logEvent(log, "worktree.removed", { repo: wt.repo, branch: wt.branch });
}

/**
 * Stage switch of a code task: create the git worktree (new branch from the repo's base), record it and
 * save the approved plan next to it. Returns the worktree + execute scratch dir, or a failure result
 * (nothing is left behind: a failed or stopped switch removes the worktree again).
 */
export async function startWorktree(
  deps: CodeFlowDeps,
  i: CodeFlowInput,
  repo: Repo,
  plan: string,
): Promise<{ wt: WorktreeRow; execScratch: string } | FlowResult> {
  const paths = workspacePaths(deps.config.agentHome).workspace(repo.name);
  const base = repo.defaultBranch ?? "main";
  const branch = `agent/${i.taskId.slice(0, 8)}`;
  const wtPath = join(paths.worktrees, i.taskId);
  try {
    await createTaskWorktree(deps.git, { repoPath: repo.path, worktreePath: wtPath, branch, base });
  } catch (err) {
    return failResult(`Could not create the worktree: ${errText(err)}`);
  }
  const wt: WorktreeRow = {
    taskId: i.taskId,
    threadId: i.threadId,
    repo: repo.name,
    repoPath: repo.path,
    path: wtPath,
    branch,
    base,
    prUrl: null,
    createdAt: Date.now(),
  };
  const execScratch = join(paths.tasks, i.taskId);
  try {
    if (i.ac.signal.aborted) throw new Error("stopped");
    insertWorktree(deps.db, wt);
    mkdirSync(execScratch, { recursive: true, mode: 0o700 });
    writeFileSync(join(execScratch, "plan.md"), plan);
  } catch (err) {
    await removeTaskWorktree(deps.git, {
      repoPath: repo.path,
      path: wtPath,
      branch,
      repo: repo.name,
    });
    try {
      deleteWorktree(deps.db, i.taskId);
    } catch {
      /* row may not exist */
    }
    return i.ac.signal.aborted
      ? failResult("Stopped.", "aborted")
      : failResult(`Could not start the task: ${errText(err, 200)}`);
  }
  logEvent(log, "worktree.created", { repo: repo.name, branch, base });
  return { wt, execScratch };
}

/** `cleanup:` removes a worktree + its local branch: this thread's, or a task's by id. Returns the reply. */
export async function cleanupWorktree(
  deps: { db: Database; git: GitMcp; inUse: (threadId: string) => boolean },
  threadId: string,
  taskId?: string,
): Promise<string> {
  const { db } = deps;
  const wt = taskId ? getWorktreeByTask(db, taskId) : getWorktreeByThread(db, threadId);
  if (!wt) return "No worktree found to clean up.";
  if (deps.inUse(wt.threadId)) return "That worktree is in use by a running task.";
  try {
    await removeTaskWorktree(deps.git, wt);
    deleteWorktree(db, wt.taskId);
    deleteSession(db, wt.threadId);
  } catch (err) {
    log.error({ err: errText(err) }, "cleanup failed");
    return OUTCOME_REPLY.error!;
  }
  return `Removed worktree and local branch ${wt.branch} (unpushed commits are gone).`;
}
