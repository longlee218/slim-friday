import type { Database } from "bun:sqlite";

/* Item age (no schema change): when did an item's current dispatch window start? Read from rows that already exist. */

/** A goal item over its age limit. */
export interface AgedItem {
  id: string;
  threadId: string;
  /** Epoch ms the item's age clock started. */
  clockStart: number;
}

/**
 * Goal items in `ready`, `running` or `waiting_user` whose age exceeds `maxAgeMs` at `now`. The clock:
 * - started item: the FIRST turn start at or after the item's newest `retry` event (0 when it never was retried).
 *   Automatic resumes add turns but never move the MIN; a lead `RetryTask` writes a newer `retry` event (and an answer that resumed a `waiting_user` item a newer `answer` event with `afterTurn`), so the clock resets.
 * - never-started item (or retried and not started yet): `owned_tasks.last_progress_at`. The status move to `ready` stamps it
 *   and nothing else writes it while the item is not running. If a future change writes it for waiting items, the
 *   slot-wait clock resets silently (a test pins this).
 */
export function agedItems(db: Database, now: number, maxAgeMs: number): AgedItem[] {
  return db
    .query<AgedItem, [number, number]>(
      `SELECT id, threadId, clockStart FROM (
         SELECT t.id AS id, t.thread_id AS threadId,
           COALESCE(
             (SELECT MIN(u.started_at) FROM turns u
               WHERE u.owned_task_id = t.id
                 AND u.started_at >= COALESCE(
                   (SELECT MAX(e.created_at) FROM thread_events e WHERE e.item_id = t.id
                      AND (e.kind = 'retry' OR (e.kind = 'answer' AND json_extract(e.payload, '$.afterTurn') IS NOT NULL))), 0)),
             t.last_progress_at) AS clockStart
         FROM owned_tasks t
         WHERE t.parent_id IS NOT NULL AND t.status IN ('ready', 'running', 'waiting_user'))
       WHERE ? - clockStart > ?
       ORDER BY clockStart`,
    )
    .all(now, maxAgeMs);
}
