import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

/** One git worktree created for a staged task. */
export interface WorktreeRow {
  taskId: string;
  threadId: string;
  /** Registry name of the repo. */
  repo: string;
  /** Absolute path of the main clone. */
  repoPath: string;
  /** Absolute path of the worktree. */
  path: string;
  branch: string;
  /** Default branch the worktree was cut from. */
  base: string;
  /** Set once the PR is opened. */
  prUrl: string | null;
  createdAt: number;
}

/** Raw sqlite row (snake_case). */
interface Raw {
  task_id: string;
  thread_id: string;
  repo: string;
  repo_path: string;
  path: string;
  branch: string;
  base: string;
  pr_url: string | null;
  created_at: number;
}

/** Map a sqlite row to the camelCase shape. */
const toRow = (r: Raw | null): WorktreeRow | null =>
  r && {
    taskId: r.task_id,
    threadId: r.thread_id,
    repo: r.repo,
    repoPath: r.repo_path,
    path: r.path,
    branch: r.branch,
    base: r.base,
    prUrl: r.pr_url,
    createdAt: r.created_at,
  };

/** Insert a worktree row; `prUrl` and `createdAt` default to null / now. */
export function insertWorktree(
  db: Database,
  w: Omit<WorktreeRow, "prUrl" | "createdAt"> & { prUrl?: string | null; createdAt?: number },
): void {
  db.query(
    "INSERT INTO worktrees (task_id, thread_id, repo, repo_path, path, branch, base, pr_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    w.taskId,
    w.threadId,
    w.repo,
    w.repoPath,
    w.path,
    w.branch,
    w.base,
    w.prUrl ?? null,
    w.createdAt ?? Date.now(),
  );
}

/** Latest worktree of a thread, or null. */
export function getWorktreeByThread(db: Database, threadId: string): WorktreeRow | null {
  return toRow(
    db
      .query<Raw, [string]>(
        "SELECT * FROM worktrees WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(threadId),
  );
}

/** Worktree of a task, or null. */
export function getWorktreeByTask(db: Database, taskId: string): WorktreeRow | null {
  return toRow(db.query<Raw, [string]>("SELECT * FROM worktrees WHERE task_id = ?").get(taskId));
}

/** Record the PR url of a task's worktree. */
export function setPrUrl(db: Database, taskId: string, url: string): void {
  db.query("UPDATE worktrees SET pr_url = ? WHERE task_id = ?").run(url, taskId);
}

/** Forget a worktree row (after cleanup). */
export function deleteWorktree(db: Database, taskId: string): void {
  db.query("DELETE FROM worktrees WHERE task_id = ?").run(taskId);
}

/** Worktree of a thread when its directory still exists, else undefined. */
export function liveWorktree(db: Database, threadId: string): WorktreeRow | undefined {
  const w = getWorktreeByThread(db, threadId);
  return w && existsSync(w.path) ? w : undefined;
}

/** Every worktree row (startup hygiene). */
export function listWorktrees(db: Database): WorktreeRow[] {
  return db
    .query<Raw, []>("SELECT * FROM worktrees")
    .all()
    .map((r) => toRow(r)!);
}
