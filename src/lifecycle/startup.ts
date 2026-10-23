import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { syncAll } from "../memory/index/memory-sync";
import { safely } from "../memory/index/safely";
import { pruneMemory } from "../memory/memory-prune";
import { logEvent, logger } from "../observability/logger";
import { sweepStalePlugins } from "../runtime/skills-plugin/plugin-sweep";

/** Raw per-task logs older than this are deleted at startup. */
const LOG_RETENTION_DAYS = 30;

const log = logger.child({ module: "startup" });

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

/** Startup hygiene: log retention + stale plugin dirs + journal retention + memory index sync. Never throws (best effort). */
export async function runStartupHygiene(db: Database, agentHome: string): Promise<void> {
  try {
    cleanupTaskLogs(agentHome);
    sweepStalePlugins(agentHome);
  } catch (err) {
    log.warn({ err: String(err) }, "startup hygiene failed");
  }
  // Expired episodes and old journal day files go first, so the sync below drops their index rows.
  safely("memory prune", () => pruneMemory(db, agentHome));
  // Memory search index in line with the files (a failure is logged; search then reports "index unavailable").
  const synced = safely("startup sync", () => syncAll(db, agentHome));
  if (synced) logEvent(log, "memory.index.synced", { ...synced });
}
