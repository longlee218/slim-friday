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
  /** Workspace of the repo (null on rows of the old git-worktree layout). */
  workspace: string | null;
  /** Commit of the base branch the clone was cut from; null = old git-worktree row (legacy cleanup). */
  baseSha: string | null;
  /** `origin` url of the owner repo at create time (legacy: the app pushed to it before Rev 15); null = none. */
  originUrl: string | null;
  /** How the result is delivered: `pr` (GitHub origin) or `local`; null on old rows. */
  delivery: "pr" | "local" | null;
  status: "active" | "delivered" | "kept" | "removed";
  /** Patch file of a `local` delivery. */
  patchPath: string | null;
  deliveredAt: number | null;
}

/** Fields of a new row that default (null / now / active). */
type Defaulted =
  | "prUrl"
  | "createdAt"
  | "workspace"
  | "baseSha"
  | "originUrl"
  | "delivery"
  | "status"
  | "patchPath"
  | "deliveredAt";

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
  workspace: string | null;
  base_sha: string | null;
  origin_url: string | null;
  delivery: "pr" | "local" | null;
  status: WorktreeRow["status"];
  patch_path: string | null;
  delivered_at: number | null;
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
    workspace: r.workspace,
    baseSha: r.base_sha,
    originUrl: r.origin_url,
    delivery: r.delivery,
    status: r.status ?? "active",
    patchPath: r.patch_path,
    deliveredAt: r.delivered_at,
  };

/** Insert a worktree row; optional fields default to null / now / `active`. */
export function insertWorktree(
  db: Database,
  w: Omit<WorktreeRow, Defaulted> & Partial<Pick<WorktreeRow, Defaulted>>,
): void {
  db.query(
    "INSERT INTO worktrees (task_id, thread_id, repo, repo_path, path, branch, base, pr_url, created_at, workspace, base_sha, origin_url, delivery, status, patch_path, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    w.workspace ?? null,
    w.baseSha ?? null,
    w.originUrl ?? null,
    w.delivery ?? null,
    w.status ?? "active",
    w.patchPath ?? null,
    w.deliveredAt ?? null,
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

/** Mark a clone delivered (PR opened or local result posted); `patchPath` is the patch file of a local delivery. */
export function setDelivered(
  db: Database,
  taskId: string,
  delivery: "pr" | "local",
  patchPath: string | null,
): void {
  db.query(
    "UPDATE worktrees SET status = 'delivered', delivery = ?, patch_path = ?, delivered_at = ? WHERE task_id = ?",
  ).run(delivery, patchPath, Date.now(), taskId);
}

/** Set the status of a clone row (`kept` = the owner keeps it until retention). */
export function setWorktreeStatus(
  db: Database,
  taskId: string,
  status: WorktreeRow["status"],
): void {
  db.query("UPDATE worktrees SET status = ? WHERE task_id = ?").run(status, taskId);
}

/** Clone rows of one workspace (oldest first): the scope of `/cleanup <id>` and the kept cap. */
export function listWorktreesOfWorkspace(db: Database, workspace: string): WorktreeRow[] {
  return db
    .query<Raw, [string]>("SELECT * FROM worktrees WHERE workspace = ? ORDER BY created_at, rowid")
    .all(workspace)
    .map((r) => toRow(r) as WorktreeRow);
}

/**
 * Clones of a workspace the owner still holds: `kept`, or `delivered` locally (the owner has to fetch it).
 * A PR-delivered clone is not counted: its work is on GitHub. Old git-worktree rows (no `baseSha`) are not
 * counted either: retention never expires them, so they would hold the cap forever (only `/cleanup` frees them).
 */
export function listKeptClones(db: Database, workspace: string): WorktreeRow[] {
  return listWorktreesOfWorkspace(db, workspace).filter(
    (w) =>
      w.baseSha !== null &&
      (w.status === "kept" || (w.status === "delivered" && w.delivery === "local")),
  );
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
