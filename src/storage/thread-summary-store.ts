import type { Database } from "bun:sqlite";
import { redactText } from "../observability/redact";

/** Max chars of a stored summary (clipped on save, after redaction). */
export const THREAD_SUMMARY_MAX_CHARS = 8000;

/**
 * Keys of a thread summary in the memory index (shared by phases 6 and 9). `memory_files.path` is
 * `summary/<threadId>`: one row per thread, replaced on save, deleted by path only (never path + workspace).
 * The search-hit id may carry `@<cycle>` so a stale hit can be detected.
 */
const SUMMARY_PATH_PREFIX = "summary/";
export const summaryPath = (threadId: string): string => `${SUMMARY_PATH_PREFIX}${threadId}`;
export const summaryHitId = (threadId: string, cycle: number): string =>
  `${summaryPath(threadId)}@${cycle}`;

/** Row of `thread_summaries`. `cycle` counts SDK compactions; `rolled_at` is retired (always 0, the column goes in phase 4); `flushed_cycle` = `cycle` at the last memory flush. */
export interface ThreadSummaryRow {
  thread_id: string;
  workspace: string;
  summary: string;
  rolled_at: number;
  updated_at: number;
  cycle: number;
  flushed_cycle: number;
}

/** Summary saved for a thread, or null. */
export function getThreadSummary(db: Database, threadId: string): ThreadSummaryRow | null {
  return db
    .query<ThreadSummaryRow, [string]>("SELECT * FROM thread_summaries WHERE thread_id = ?")
    .get(threadId);
}

/** Upsert the summary (redacted, clipped). Keeps `cycle` and `flushed_cycle` of an existing row. */
export function saveSummary(
  db: Database,
  threadId: string,
  workspace: string,
  summary: string,
  now = Date.now(),
): void {
  const text = redactText(summary).slice(0, THREAD_SUMMARY_MAX_CHARS);
  db.query(
    `INSERT INTO thread_summaries (thread_id, workspace, summary, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET workspace = excluded.workspace, summary = excluded.summary,
       updated_at = excluded.updated_at`,
  ).run(threadId, workspace, text, now);
}

/*
 * Cycle contract: `cycle` = number of SDK compactions the thread went through so far.
 * Flow: PostCompact `bumpCycle` + save summary -> async `needsFlush` -> flush to the channel journal -> `markFlushed`
 * (flushed_cycle = the request's cycle, monotonic), so one flush per compaction. A brand-new thread has no row, so `needsFlush` is true:
 * whether there is any transcript worth flushing is the caller's concern.
 */

/** Create the row if missing (empty summary); existing rows are left as they are. */
const ENSURE_ROW = `INSERT INTO thread_summaries (thread_id, workspace, summary, updated_at) VALUES (?, ?, '', ?)
  ON CONFLICT(thread_id) DO NOTHING`;

/** Mid-run compaction happened: count one more cycle (creates the row when missing). */
export function bumpCycle(db: Database, threadId: string, workspace: string): void {
  db.transaction(() => {
    db.query(ENSURE_ROW).run(threadId, workspace, Date.now());
    db.query("UPDATE thread_summaries SET cycle = cycle + 1 WHERE thread_id = ?").run(threadId);
  })();
}

/**
 * Memory flush of `cycle` done (idempotent; creates the row when missing). `flushed_cycle` only moves forward, and
 * never past `cycle`: a late flush N cannot mark a compaction N+1 that was queued meanwhile.
 */
export function markFlushed(
  db: Database,
  threadId: string,
  workspace: string,
  cycle: number,
): void {
  db.transaction(() => {
    db.query(ENSURE_ROW).run(threadId, workspace, Date.now());
    db.query(
      "UPDATE thread_summaries SET flushed_cycle = MAX(flushed_cycle, ?) WHERE thread_id = ?",
    ).run(cycle, threadId);
  })();
}

/** True when no row exists or `cycle` was not flushed yet (`flushed_cycle < cycle`; -1 = never). */
export function needsFlush(db: Database, threadId: string, cycle: number): boolean {
  const row = getThreadSummary(db, threadId);
  return !row || row.flushed_cycle < cycle;
}

/** Drop a thread's summary. */
export function deleteThreadSummary(db: Database, threadId: string): void {
  db.query("DELETE FROM thread_summaries WHERE thread_id = ?").run(threadId);
}
