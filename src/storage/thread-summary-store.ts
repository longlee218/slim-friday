import type { Database } from "bun:sqlite";
import { abstractOf, keyTopics } from "../memory/episode-abstract";
import { logEvent, logger } from "../observability/logger";
import { redactText } from "../observability/redact";

const log = logger.child({ module: "thread-summary-store" });

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

/**
 * Row of `thread_summaries` = the episode of a thread. `cycle` counts SDK compactions; `flushed_cycle` = `cycle` at the
 * last memory flush; `channel` is the yaml channel name ('' = unknown); `promoted_at` = when dreaming consumed it.
 */
export interface ThreadSummaryRow {
  thread_id: string;
  workspace: string;
  channel: string;
  summary: string;
  key_topics: string;
  abstract: string;
  promoted_at: number;
  updated_at: number;
  cycle: number;
  flushed_cycle: number;
}

/** Where a saved episode came from (log only). */
export type EpisodeSource = "compaction" | "idle";

/** Summary saved for a thread, or null. */
export function getThreadSummary(db: Database, threadId: string): ThreadSummaryRow | null {
  return db
    .query<ThreadSummaryRow, [string]>("SELECT * FROM thread_summaries WHERE thread_id = ?")
    .get(threadId);
}

/**
 * Upsert the episode of a thread: summary (redacted, clipped), its extractive abstract and key topics, channel.
 * Keeps `cycle`, `flushed_cycle` and `promoted_at` of an existing row, and its workspace and channel when the new ones are empty; `updated_at` moves (so a promoted episode is
 * eligible again). Logs `memory.episode {source, chars, ms}` (counts only). Returns false when `unlessNewerThan` refused a stale write.
 */
export function saveSummary(
  db: Database,
  p: {
    threadId: string;
    workspace: string;
    channel: string;
    summary: string;
    source: EpisodeSource;
    /** Time the caller spent producing the summary (log only). */
    ms?: number;
    now?: number;
    /**
     * Only replace a row not updated after this time (epoch ms): the idle writer passes the `updated_at` it read, so a
     * compaction summary saved meanwhile is never overwritten by older facts.
     */
    unlessNewerThan?: number;
  },
): boolean {
  const text = redactText(p.summary).slice(0, THREAD_SUMMARY_MAX_CHARS);
  const res = db
    .query(
      `INSERT INTO thread_summaries (thread_id, workspace, channel, summary, key_topics, abstract, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       workspace = CASE WHEN excluded.workspace = '' THEN workspace ELSE excluded.workspace END,
       channel = CASE WHEN excluded.channel = '' THEN channel ELSE excluded.channel END,
       summary = excluded.summary, key_topics = excluded.key_topics, abstract = excluded.abstract,
       updated_at = MAX(updated_at, excluded.updated_at)
     WHERE ? IS NULL OR updated_at <= ?`,
    )
    .run(
      p.threadId,
      p.workspace,
      p.channel,
      text,
      keyTopics(text),
      abstractOf(text),
      p.now ?? Date.now(),
      p.unlessNewerThan ?? null,
      p.unlessNewerThan ?? null,
    );
  // 0 changes = the guard refused (a newer summary is stored).
  if (res.changes === 0) {
    logEvent(log, "memory.episode_stale_skipped", { source: p.source });
    return false;
  }
  logEvent(log, "memory.episode", { source: p.source, chars: text.length, ms: p.ms ?? 0 });
  return true;
}

/*
 * Cycle contract: `cycle` = number of SDK compactions the thread went through so far.
 * Flow: PostCompact `bumpCycle` + save summary -> async `needsFlush` -> flush to the channel journal -> `markFlushed`
 * (flushed_cycle = the request's cycle, monotonic), so one flush per compaction. A brand-new thread has no row, so `needsFlush` is true:
 * whether there is any transcript worth flushing is the caller's concern.
 */

/** Create the row if missing (empty summary); existing rows are left as they are. */
const ENSURE_ROW = `INSERT INTO thread_summaries (thread_id, workspace, channel, summary, updated_at) VALUES (?, ?, ?, '', ?)
  ON CONFLICT(thread_id) DO NOTHING`;

/** Mid-run compaction happened: count one more cycle (creates the row when missing). */
export function bumpCycle(db: Database, threadId: string, workspace: string, channel = ""): void {
  db.transaction(() => {
    db.query(ENSURE_ROW).run(threadId, workspace, channel, Date.now());
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
  channel = "",
): void {
  db.transaction(() => {
    db.query(ENSURE_ROW).run(threadId, workspace, channel, Date.now());
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
