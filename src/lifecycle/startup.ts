import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { realOrSame } from "../guardrails/paths";
import { cleanupAttachments } from "../ingress/attachment-summary";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { sweepStalePlugins } from "../runtime/workspace-skills-plugin";
import { deleteWorktree, listWorktrees } from "../storage/worktree-store";
import { safeRemoveClone } from "../workspaces/clone-safety";
import {
  DAY_MS,
  DEFAULT_CLONE_RETENTION_DAYS,
  expireClones,
  expireLegacyWorktrees,
} from "./clone-retention";

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
 * Compare clone dirs with db rows. A dir without a row is logged (`clone.orphan`) and removed (safe remove)
 * when older than the retention; a row whose dir is gone (an `active` clone lost) is logged and deleted.
 * Returns the orphan dirs, the lost task ids and the orphan dirs removed.
 */
export function checkWorktrees(
  db: Database,
  agentHome: string,
  retentionDays = DEFAULT_CLONE_RETENTION_DAYS,
  now = Date.now(),
) {
  const paths = workspacePaths(agentHome);
  const rows = listWorktrees(db);
  const known = new Set(rows.map((r) => realOrSame(r.path)));
  const noRow: string[] = [];
  const removedOrphans: string[] = [];
  for (const w of subdirs(paths.workspaces)) {
    const ws = paths.workspace(w);
    for (const r of subdirs(ws.repos)) {
      const root = ws.repo(r).worktrees;
      for (const d of subdirs(root)) {
        const path = join(root, d);
        if (known.has(realOrSame(path))) continue;
        noRow.push(path);
        try {
          const old = statSync(path).mtimeMs < now - retentionDays * DAY_MS;
          logEvent(log, "clone.orphan", { reason: "no_db_row", path, old }, "warn");
          if (old && safeRemoveClone(path, root)) removedOrphans.push(path);
        } catch (err) {
          // A broken symlink or a vanished entry must not abort the rest of the startup hygiene.
          log.warn({ path, err: errText(err) }, "orphan check failed");
        }
      }
    }
  }
  // A row whose dir is gone is dropped, unless the worktrees root itself is missing (unmounted disk, moved
  // home): that may be transient, so the row is only reported.
  const missingDir = rows.filter((r) => !existsSync(r.path));
  for (const r of missingDir) {
    const rootGone = !existsSync(dirname(r.path));
    const reason = rootGone ? "root_missing" : "missing_dir";
    logEvent(log, "clone.orphan", { reason, taskId: r.taskId, path: r.path }, "warn");
    if (!rootGone) deleteWorktree(db, r.taskId);
  }
  return { noRow, missingDir: missingDir.map((r) => r.taskId), removedOrphans };
}

/** Startup hygiene: log retention + stale plugin dirs + clone + legacy worktree retention and orphan check. Never throws (best effort). */
export async function runStartupHygiene(
  db: Database,
  agentHome: string,
  cloneRetentionDays = DEFAULT_CLONE_RETENTION_DAYS,
): Promise<void> {
  try {
    cleanupTaskLogs(agentHome);
    sweepStalePlugins(agentHome);
    expireClones(db, agentHome, cloneRetentionDays);
    checkWorktrees(db, agentHome, cloneRetentionDays);
    cleanupAttachments(agentHome);
    await expireLegacyWorktrees(db, agentHome, cloneRetentionDays);
  } catch (err) {
    log.warn({ err: String(err) }, "startup hygiene failed");
  }
}
