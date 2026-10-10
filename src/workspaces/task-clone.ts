import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import type { GitIdentity } from "../mcp/git-mcp";
import { parseRemote } from "../mcp/github-mcp";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import type { StageRunInput, StageRunnerDeps } from "../orchestrator/engine/stage-runner";
import { type FlowResult, failResult } from "../orchestrator/tasks/task-result";
import { gitOut, runGit } from "../repos/git-cli";
import { type Repo, resolveAuthor } from "../repos/repo-registry";
import {
  deleteWorktree,
  getWorktreeByTask,
  insertWorktree,
  type WorktreeRow,
} from "../storage/worktree-store";
import {
  CloneRefusal,
  preflight,
  safeRemoveClone,
  TASK_BRANCH_RE,
  taskBranch,
} from "./clone-safety";

/* Independent local clone per code task (`isolation: "clone"`): a plain `git clone --local` of the owner's
   repo into `workspaces/<ws>/repos/<name>/worktrees/<taskId>`. The owner repo's `.git` is only read:
   no worktree entry, no branch, no config change. Local base, no fetch, no `origin` in the clone. */

const log = logger.child({ module: "task-clone" });

/** What a created clone records about its origin. */
export interface CreatedClone {
  baseSha: string;
  /** `origin` url of the owner repo (read once, never fetched); null when it has none. */
  originUrl: string | null;
}

/** Create the clone on a new `branch` cut from the local `base`. Throws `CloneRefusal` or an Error; leaves nothing behind. */
export async function createTaskClone(o: {
  repoPath: string;
  clonePath: string;
  /** Parent dir of every clone of this repo (the removal root). */
  cloneRoot: string;
  base: string;
  branch: string;
  author: GitIdentity;
  minFreeBytes?: number;
}): Promise<CreatedClone> {
  if (!TASK_BRANCH_RE.test(o.branch)) throw new CloneRefusal("The task branch name is not valid.");
  // Never reuse a directory: the cleanup below must only ever remove what this call created.
  if (existsSync(o.clonePath)) throw new CloneRefusal("A clone for this task already exists.");
  mkdirSync(o.cloneRoot, { recursive: true, mode: 0o700 });
  const baseSha = await preflight(o.repoPath, o.base, o.cloneRoot, o.minFreeBytes);
  try {
    // `--` ends options, so a path can never read as a git flag. `--local` hardlinks the objects.
    await gitOut(
      ["clone", "--local", "--branch", o.base, "--single-branch", "--", o.repoPath, o.clonePath],
      o.cloneRoot,
    );
    // Nothing in the clone may reach the owner checkout: drop the remote. The PR push (P2.2) is made by
    // the app with an explicit url, never through a clone remote.
    await gitOut(["remote", "remove", "origin"], o.clonePath);
    await gitOut(["switch", "-c", o.branch], o.clonePath);
    // Written once here (not read from the machine's global git user).
    await gitOut(["config", "--local", "user.name", o.author.name], o.clonePath);
    await gitOut(["config", "--local", "user.email", o.author.email], o.clonePath);
  } catch (err) {
    safeRemoveClone(o.clonePath, o.cloneRoot);
    throw err;
  }
  const origin = await runGit(["remote", "get-url", "origin"], o.repoPath);
  return { baseSha, originUrl: origin.code === 0 ? origin.stdout.trim() || null : null };
}

/** `pr` when the owner repo's origin is a GitHub repo (the PR gate applies), else `local`. */
export const deliveryFor = (originUrl: string | null): "pr" | "local" =>
  originUrl && /github\.com/i.test(originUrl) && parseRemote(originUrl) ? "pr" : "local";

/**
 * Stage switch of a staged task: create the clone (new branch from the local base), record it and save the
 * approved plan next to it. Returns the clone row + execute scratch dir, or a failure result (nothing is
 * left behind: a failed or stopped switch removes the clone and its row again).
 */
export async function startWorktree(
  deps: StageRunnerDeps,
  i: StageRunInput,
  repo: Repo,
  plan: string,
  planFile = "plan.md",
): Promise<{ wt: WorktreeRow; execScratch: string } | FlowResult> {
  const ws = workspacePaths(deps.config.agentHome).workspace(i.workspace);
  const author = resolveAuthor(repo, deps.config);
  if (!author) return failResult(`No commit identity for ${repo.name}.`);
  // A task id with a row already has a clone: never create (or later delete) over it.
  if (getWorktreeByTask(deps.db, i.taskId)) return failResult("This task already has a clone.");
  const base = i.base ?? repo.defaultBranch ?? "main";
  const branch = taskBranch(i.taskId, i.text);
  const cloneRoot = ws.repo(repo.name).worktrees;
  const clonePath = join(cloneRoot, i.taskId);
  let made: CreatedClone;
  try {
    made = await createTaskClone({
      repoPath: repo.path,
      clonePath,
      cloneRoot,
      base,
      branch,
      author,
    });
  } catch (err) {
    const msg = errText(err, 300);
    logEvent(log, "clone.refused", { repo: repo.name, base, reason: msg }, "warn");
    return failResult(
      err instanceof CloneRefusal ? msg : `Could not create the task clone: ${msg}`,
    );
  }
  const wt: WorktreeRow = {
    taskId: i.taskId,
    threadId: i.threadId,
    repo: repo.name,
    repoPath: repo.path,
    path: clonePath,
    branch,
    base,
    prUrl: null,
    createdAt: Date.now(),
    workspace: i.workspace,
    baseSha: made.baseSha,
    originUrl: made.originUrl,
    delivery: deliveryFor(made.originUrl),
    status: "active",
    patchPath: null,
    deliveredAt: null,
  };
  const execScratch = ws.task(i.taskId).root;
  let inserted = false;
  try {
    if (i.ac.signal.aborted) throw new Error("stopped");
    insertWorktree(deps.db, wt);
    inserted = true;
    mkdirSync(execScratch, { recursive: true, mode: 0o700 });
    writeFileSync(join(execScratch, planFile), plan);
  } catch (err) {
    // Undo only what this call made: the clone (checked absent above) and the row if it was inserted.
    safeRemoveClone(clonePath, cloneRoot);
    if (inserted) deleteWorktree(deps.db, i.taskId);
    return i.ac.signal.aborted
      ? failResult("Stopped.", "aborted")
      : failResult(`Could not start the task: ${errText(err, 200)}`);
  }
  logEvent(log, "clone.created", { repo: repo.name, branch, base, baseSha: made.baseSha });
  return { wt, execScratch };
}
