import type { Database } from "bun:sqlite";
import type { RecentMessage } from "../../intent/intent-types";
import { getThreadSummary } from "../../storage/thread-summary-store";

/**
 * Seed of the first run after a rollover (the session was dropped): the saved thread summary + the thread's last
 * Discord messages, as prompt-context fields. Seeded ONCE per rollover: empty when the thread never rolled
 * (`rolled_at` 0) or when a run of this thread (other than `turnId`) already finished successfully since the roll
 * (it saw the seed; a session lost later starts from the stored memory and the ledger, not a stale summary).
 * The caller asks only when no session lives, so a thread with a live session is never seeded.
 */
export function rolloverSeed(
  db: Database,
  threadId: string,
  turnId: string,
  recent: readonly RecentMessage[] | undefined,
): { threadSummary?: string; recent?: readonly RecentMessage[] } {
  const row = getThreadSummary(db, threadId);
  if (!row || row.rolled_at <= 0) return {};
  const seen = db
    .query<{ n: number }, [string, string, number]>(
      "SELECT COUNT(*) AS n FROM turns WHERE thread_id = ? AND id != ? AND status = 'done' AND started_at >= ?",
    )
    .get(threadId, turnId, row.rolled_at);
  return seen && seen.n > 0 ? {} : { threadSummary: row.summary, recent };
}
