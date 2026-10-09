import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { realOrSame } from "../guardrails/paths";
import { logEvent, logger } from "../observability/logger";
import { sweepStalePlugins } from "../runtime/workspace-skills-plugin";
import { deleteWorktree, listWorktrees } from "../storage/worktree-store";

/** Raw per-task logs older than this are deleted at startup. */
export const LOG_RETENTION_DAYS = 30;

const log = logger.child({ module: "startup" });

/** Names of the subdirectories of `dir` ([] when it does not exist). */
function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

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
 * Compare worktree dirs with db rows. Dirs without a row are only logged (`worktree.orphan`, for manual
 * cleanup); rows whose dir is gone are logged and deleted. Returns both lists.
 */
export function checkWorktrees(db: Database, agentHome: string) {
  const paths = workspacePaths(agentHome);
  const rows = listWorktrees(db);
  const known = new Set(rows.map((r) => realOrSame(r.path)));
  const noRow: string[] = [];
  for (const w of subdirs(paths.workspaces)) {
    const ws = paths.workspace(w);
    for (const r of subdirs(ws.repos)) {
      const root = ws.repo(r).worktrees;
      for (const d of subdirs(root)) {
        const path = join(root, d);
        if (known.has(realOrSame(path))) continue;
        noRow.push(path);
        logEvent(log, "worktree.orphan", { reason: "no_db_row", path }, "warn");
      }
    }
  }
  // A row whose dir is gone is dropped, unless the worktrees root itself is missing (unmounted disk, moved
  // home): that may be transient, so the row is only reported.
  const missingDir = rows.filter((r) => !existsSync(r.path));
  for (const r of missingDir) {
    const rootGone = !existsSync(dirname(r.path));
    const reason = rootGone ? "root_missing" : "missing_dir";
    logEvent(log, "worktree.orphan", { reason, taskId: r.taskId, path: r.path }, "warn");
    if (!rootGone) deleteWorktree(db, r.taskId);
  }
  return { noRow, missingDir: missingDir.map((r) => r.taskId) };
}

/** Startup hygiene: log retention + stale plugin dirs + worktree orphan check. Never throws (best effort). */
export function runStartupHygiene(db: Database, agentHome: string): void {
  try {
    cleanupTaskLogs(agentHome);
    sweepStalePlugins(agentHome);
    checkWorktrees(db, agentHome);
  } catch (err) {
    log.warn({ err: String(err) }, "startup hygiene failed");
  }
}
