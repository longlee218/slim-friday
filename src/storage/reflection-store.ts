import type { Database } from "bun:sqlite";

/* Goals to reflect on after they closed with a failure signal, and their facts. A reflected goal is marked by a
   `memory_promotions` row with hash `reflect:<goalId>` (pruned after the journal retention, far past the window). SQL here only. */

/** Hash of the marker row of a reflected goal. */
export const reflectMark = (goalId: string): string => `reflect:${goalId}`;

/** A closed goal with a failure signal that has no reflection yet. */
export interface GoalToReflect {
  goalId: string;
  threadId: string;
  /** Discord channel of the goal's thread; null when the thread row is gone. */
  channelId: string | null;
  status: string;
}

/**
 * Goals closed (completed, failed, cancelled) at or after `since` with a failure signal: a `fix-N` item, a failed
 * item, or a `failure` event. Oldest first, at most `limit`; goals already marked are left out.
 */
export function goalsToReflect(db: Database, since: number, limit: number): GoalToReflect[] {
  return db
    .query<GoalToReflect, [number, number]>(
      `SELECT g.id AS goalId, g.thread_id AS threadId, th.channel_id AS channelId, g.status AS status
       FROM owned_tasks g
       LEFT JOIN threads th ON th.thread_id = g.thread_id
       WHERE g.parent_id IS NULL AND g.status IN ('completed', 'failed', 'cancelled') AND g.last_progress_at >= ?
         AND (EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id
                      AND (i.item_key LIKE 'fix-%' OR i.status = 'failed'))
              OR EXISTS (SELECT 1 FROM thread_events e WHERE e.kind = 'failure' AND e.task_id = g.id))
         AND NOT EXISTS (SELECT 1 FROM memory_promotions p WHERE p.hash = 'reflect:' || g.id)
       ORDER BY g.last_progress_at, g.rowid LIMIT ?`,
    )
    .all(since, limit);
}

/** The facts of one goal as plain text (scope, status, items, failure codes): the reflection's input, data only. */
export function goalFacts(db: Database, goalId: string): string {
  const goal = db
    .query<{ scope: string; status: string }, [string]>(
      "SELECT scope, status FROM owned_tasks WHERE id = ?",
    )
    .get(goalId);
  if (!goal) return "";
  const items = db
    .query<
      {
        key: string | null;
        role: string | null;
        status: string;
        location: string | null;
        excerpt: string | null;
      },
      [string]
    >(
      `SELECT item_key AS key, owner_role AS role, status, location, result_excerpt AS excerpt
       FROM owned_tasks WHERE parent_id = ? ORDER BY created_at, rowid`,
    )
    .all(goalId);
  const failures = db
    .query<{ payload: string }, [string]>(
      "SELECT payload FROM thread_events WHERE kind = 'failure' AND task_id = ? ORDER BY seq",
    )
    .all(goalId);
  return [
    `Goal ${goalId} [${goal.status}]: ${goal.scope}`,
    "Items:",
    ...items.map(
      (i) =>
        `- ${i.key ?? "?"} (${i.role ?? "?"}${i.location ? ` @ ${i.location}` : ""}) [${i.status}]: ${i.excerpt ?? "(no result)"}`,
    ),
    ...(failures.length ? ["Failure events:", ...failures.map((f) => `- ${f.payload}`)] : []),
  ].join("\n");
}
