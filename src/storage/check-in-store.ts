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
 * Open goals with at least one `running` item or one held item (`blocked`), oldest first. A thread may hold
 * several: the caller keeps the newest (last) per thread.
 */
export function goalsWithLiveWork(db: Database): DigestGoal[] {
  return db
    .query<DigestGoal, []>(
      `SELECT g.id AS goalId, g.thread_id AS threadId, g.scope AS objective FROM owned_tasks g
       WHERE g.parent_id IS NULL AND g.status = 'open'
         AND EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id
                     AND i.status IN ('running', 'blocked'))
       ORDER BY g.rowid`,
    )
    .all();
}

/** A held item that waited long enough for the teammate's decision. */
export interface HeldItem {
  itemId: string;
  goalId: string;
  threadId: string;
  itemKey: string;
  dispatchCount: number;
  /** Epoch ms the item was held (its newest `failure` / `blocked` / `budget_hit` event; `last_progress_at` when it has none). */
  heldAt: number;
}

/**
 * Held items (`blocked`) of an OPEN goal, held at or before `now - waitMs` and not before `now - maxHeldMs` (a forgotten
 * hold), with no `retry` / `cancel` event at or after the moment they were held (a retry moves the item out of `blocked`;
 * the event check guards a stale row) and no escalation (`timeout`, cause `hold_undecided`) of this hold in the last
 * `repeatMs` (so an undecided hold wakes the teammate again after that floor). Oldest first, at most `limit` rows.
 */
export function heldTooLong(
  db: Database,
  now: number,
  waitMs: number,
  maxHeldMs: number,
  limit: number,
  repeatMs: number,
): HeldItem[] {
  return db
    .query<HeldItem, [number, number, number, number, number]>(
      `SELECT h.id AS itemId, h.goalId, h.threadId, h.itemKey, h.dispatchCount, h.heldAt FROM (
         SELECT t.id AS id, t.parent_id AS goalId, t.thread_id AS threadId, t.item_key AS itemKey,
           t.dispatch_count AS dispatchCount,
           COALESCE((SELECT MAX(e.created_at) FROM thread_events e
                      WHERE e.item_id = t.id AND e.kind IN ('failure', 'blocked', 'budget_hit')),
                    t.last_progress_at) AS heldAt
         FROM owned_tasks t JOIN owned_tasks g ON g.id = t.parent_id
         WHERE t.status = 'blocked' AND g.status = 'open') h
       WHERE h.heldAt <= ? - ? AND h.heldAt >= ? - ?
         AND NOT EXISTS (SELECT 1 FROM thread_events d WHERE d.item_id = h.id AND d.kind IN ('retry', 'cancel')
                         AND d.created_at >= h.heldAt)
         AND NOT EXISTS (SELECT 1 FROM thread_events x WHERE x.item_id = h.id AND x.kind = 'timeout'
                         AND json_extract(x.payload, '$.cause') = 'hold_undecided'
                         AND x.created_at >= h.heldAt AND x.created_at > ? - ${Math.trunc(repeatMs)})
       ORDER BY h.heldAt LIMIT ${Math.trunc(limit)}`,
    )
    .all(now, waitMs, now, maxHeldMs, now);
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
