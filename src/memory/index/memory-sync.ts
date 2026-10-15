import type { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { workspacePaths } from "../../config/workspace-paths";
import { summaryPath } from "../../storage/thread-summary-store";
import { classifyFile, listWorkspaces, workspaceFiles } from "./memory-files";
import { THREAD_ID } from "./memory-ids";
import { indexSummary, ledger, purgePath, reindexFile, type SummaryRow } from "./memory-index";

/** Outcome of a sync. `errors` = files/threads that failed (kept as they were); the caller reports a stale index. */
export interface SyncResult {
  reindexed: number;
  purged: number;
  errors: number;
}

/** lstat of a regular file, or null. */
function statOf(file: string): { mtimeMs: number; size: number } | null {
  try {
    const st = lstatSync(file);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

/** Summary rows WITHOUT the text (the text is fetched only for a changed row). */
type SummaryStamp = Pick<SummaryRow, "thread_id" | "workspace" | "updated_at" | "cycle">;

/**
 * Bring the index of ONE workspace (plus the root MEMORY.md) in line with the files and `thread_summaries`:
 * re-read only files whose mtime/size changed (summaries: updated_at/cycle), purge rows of vanished files and
 * threads. Cheap when nothing changed (one stat per file, no file read). A file or thread that throws is
 * counted in `errors` and left as it was (never purged on an error).
 */
export function syncIndex(db: Database, home: string, workspace: string): SyncResult {
  const files = [workspacePaths(home).memory, ...workspaceFiles(home, workspace)];
  const keep = new Set<string>();
  const out: SyncResult = { reindexed: 0, purged: 0, errors: 0 };
  for (const f of files) {
    try {
      if (!classifyFile(home, f)) continue;
      const st = statOf(f);
      if (!st) continue; // vanished: purged below
      keep.add(f);
      const known = ledger(db, f);
      if (known && known.mtime_ms === Math.trunc(st.mtimeMs) && known.size === st.size) continue;
      if (reindexFile(db, home, f) === "indexed") out.reindexed++;
      else keep.delete(f);
    } catch {
      keep.add(f);
      out.errors++;
    }
  }
  // Summaries of a thread without a workspace are never indexed (they could not be isolated).
  const stamps =
    workspace === ""
      ? []
      : db
          .query<SummaryStamp, [string]>(
            "SELECT thread_id, workspace, updated_at, cycle FROM thread_summaries WHERE workspace = ? AND summary <> ''",
          )
          .all(workspace);
  for (const s of stamps) {
    if (!THREAD_ID.test(s.thread_id)) continue;
    const p = summaryPath(s.thread_id);
    keep.add(p);
    try {
      const known = ledger(db, p);
      if (known && known.mtime_ms === s.updated_at && known.size === s.cycle) continue;
      const row = db
        .query<SummaryRow, [string]>(
          "SELECT thread_id, workspace, summary, updated_at, cycle FROM thread_summaries WHERE thread_id = ?",
        )
        .get(s.thread_id);
      if (!row) continue;
      indexSummary(db, row);
      out.reindexed++;
    } catch {
      out.errors++;
    }
  }
  for (const { path } of db
    .query<{ path: string }, [string]>("SELECT path FROM memory_files WHERE workspace IN (?, '')")
    .all(workspace)) {
    if (keep.has(path)) continue;
    try {
      purgePath(db, path);
      out.purged++;
    } catch {
      out.errors++;
    }
  }
  return out;
}

/** Sync every workspace (startup): also purges rows of workspaces that no longer exist. */
export function syncAll(db: Database, home: string): SyncResult {
  const known = new Set(listWorkspaces(home));
  for (const { workspace } of db
    .query<{ workspace: string }, []>(
      "SELECT DISTINCT workspace FROM thread_summaries WHERE workspace <> ''",
    )
    .all())
    known.add(workspace);
  const total = syncIndex(db, home, ""); // root only (no workspace named "")
  for (const ws of known) {
    try {
      const r = syncIndex(db, home, ws);
      total.reindexed += r.reindexed;
      total.purged += r.purged;
      total.errors += r.errors;
    } catch {
      total.errors++;
    }
  }
  for (const { workspace } of db
    .query<{ workspace: string }, []>(
      "SELECT DISTINCT workspace FROM memory_files WHERE workspace <> ''",
    )
    .all())
    if (!known.has(workspace)) {
      for (const { path } of db
        .query<{ path: string }, [string]>("SELECT path FROM memory_files WHERE workspace = ?")
        .all(workspace)) {
        purgePath(db, path);
        total.purged++;
      }
    }
  return total;
}
