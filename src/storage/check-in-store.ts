import type { Database } from "bun:sqlite";

/* Read-only queries of the check-in (digest + hold escalation). No schema change: everything is read from rows that exist. */

/** An open goal that has live work (a running item) or a held one: the digest's subject. */
export interface DigestGoal {
  goalId: string;
  threadId: string;
  /** Goal sentence (`owned_tasks.scope`), not yet redacted or clipped. */
  objective: string;
}

/**
 * Open goals with at least one `running` item or one held item (blocked + FAILED), oldest first. A thread may hold
 * several: the caller keeps the newest (last) per thread.
 */
export function goalsWithLiveWork(db: Database): DigestGoal[] {
  return db
    .query<DigestGoal, []>(
      `SELECT g.id AS goalId, g.thread_id AS threadId, g.scope AS objective FROM owned_tasks g
       WHERE g.parent_id IS NULL AND g.status = 'open'
         AND EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id
                     AND (i.status = 'running' OR (i.status = 'blocked' AND i.result_kind = 'FAILED')))
       ORDER BY g.rowid`,
    )
    .all();
}

/** A held item that waited long enough for the lead's decision. */
export interface HeldItem {
  itemId: string;
  goalId: string;
  threadId: string;
  itemKey: string;
  dispatchCount: number;
  /** Epoch ms the item was held (its newest `failure` event; `last_progress_at` when it has none). */
  heldAt: number;
}

/**
 * Held items (blocked + FAILED) of an OPEN goal, held at or before `now - waitMs` and not before `now - maxHeldMs` (a
 * forgotten hold), with no `retry` / `cancel` event at or after the moment they were held (a retry moves the item out
 * of `blocked`; the event check guards a stale row) and no escalation event for this dispatch yet. Oldest first, at
 * most `limit` rows.
 */
export function heldTooLong(
  db: Database,
  now: number,
  waitMs: number,
  maxHeldMs: number,
  limit: number,
): HeldItem[] {
  return db
    .query<HeldItem, [number, number, number, number]>(
      `SELECT h.id AS itemId, h.goalId, h.threadId, h.itemKey, h.dispatchCount, h.heldAt FROM (
         SELECT t.id AS id, t.parent_id AS goalId, t.thread_id AS threadId, t.item_key AS itemKey,
           t.dispatch_count AS dispatchCount,
           COALESCE((SELECT MAX(e.created_at) FROM thread_events e WHERE e.item_id = t.id AND e.kind = 'failure'),
                    t.last_progress_at) AS heldAt
         FROM owned_tasks t JOIN owned_tasks g ON g.id = t.parent_id
         WHERE t.status = 'blocked' AND t.result_kind = 'FAILED' AND g.status = 'open') h
       WHERE h.heldAt <= ? - ? AND h.heldAt >= ? - ?
         AND NOT EXISTS (SELECT 1 FROM thread_events d WHERE d.item_id = h.id AND d.kind IN ('retry', 'cancel')
                         AND d.created_at >= h.heldAt)
         AND NOT EXISTS (SELECT 1 FROM thread_events x WHERE x.id = 'hold:' || h.id || ':' || h.dispatchCount)
       ORDER BY h.heldAt LIMIT ${Math.trunc(limit)}`,
    )
    .all(now, waitMs, now, maxHeldMs);
}

/** `last_progress_at` (epoch ms) of every item of a goal, by item id: the last activity or status move. */
export function lastProgressOfItems(db: Database, goalId: string): Map<string, number> {
  return new Map(
    db
      .query<{ id: string; at: number }, [string]>(
        "SELECT id, last_progress_at AS at FROM owned_tasks WHERE parent_id = ?",
      )
      .all(goalId)
      .map((r) => [r.id, r.at]),
  );
}
