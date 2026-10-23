import type { Database } from "bun:sqlite";

/** One finding of a detector; `goal_id` / `turn_id` / `thread_id` say where the UI links to. */
export interface Problem {
  kind: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  at: number;
  goal_id: string | null;
  turn_id: string | null;
  thread_id: string | null;
}

/** Detector thresholds; tune here. */
const STALE_MS = 30 * 60_000;
const COSTLY_RUN_USD = 1.5;
const ERROR_CALLS = 5;
const REPEAT_CALLS = 3;
const MANY_DISPATCHES = 2;

/** Items held for the teammate: blocked or failed, inside a goal that is still open. */
function heldItems(db: Database, since: number): Problem[] {
  return db
    .query<Problem, [number]>(
      `SELECT 'held' AS kind, 'high' AS severity,
         i.status || ': ' || COALESCE(i.item_key, '') || ' (' || i.owner_role || ')' AS title,
         COALESCE(substr(i.result_excerpt, 1, 300), COALESCE(i.subject, '')) AS detail,
         i.last_progress_at AS at, i.parent_id AS goal_id, NULL AS turn_id, i.thread_id
       FROM owned_tasks i JOIN owned_tasks g ON g.id = i.parent_id
       WHERE i.status IN ('blocked', 'failed') AND g.status = 'open' AND i.last_progress_at >= ?`,
    )
    .all(since);
}

/** Running items with no progress for STALE_MS. */
function staleItems(db: Database, now: number): Problem[] {
  return db
    .query<Problem, [number, number]>(
      `SELECT 'stale' AS kind, 'high' AS severity,
         'no progress ' || ((?1 - last_progress_at) / 60000) || ' min: ' || COALESCE(item_key, '') AS title,
         COALESCE(subject, '') AS detail, last_progress_at AS at, parent_id AS goal_id, NULL AS turn_id, thread_id
       FROM owned_tasks WHERE status = 'running' AND parent_id IS NOT NULL AND last_progress_at < ?1 - ?2`,
    )
    .all(now, STALE_MS);
}

/** Runs that did not end in success, and costly runs. */
function badRuns(db: Database, since: number): Problem[] {
  return db
    .query<Problem, [number, number]>(
      `SELECT CASE WHEN r.outcome <> 'success' THEN 'run-' || r.outcome ELSE 'costly' END AS kind,
         CASE WHEN r.outcome <> 'success' THEN 'medium' ELSE 'low' END AS severity,
         t.role || ' ' || r.outcome || ' $' || printf('%.2f', r.cost_usd) || ', ' || r.turns || ' turns' AS title,
         COALESCE(substr(t.brief, 1, 200), '') AS detail, t.started_at AS at, o.parent_id AS goal_id,
         t.id AS turn_id, t.thread_id
       FROM runs r JOIN turns t ON t.id = r.turn_id LEFT JOIN owned_tasks o ON o.id = t.owned_task_id
       WHERE t.started_at >= ?1 AND (r.outcome <> 'success' OR (r.cost_usd >= ?2 AND t.role <> 'chief-of-staff'))`,
    )
    .all(since, COSTLY_RUN_USD);
}

/** Runs with many failing tool calls, and runs that repeat the same call (same tool and input) — a loop. */
function toolTrouble(db: Database, since: number): Problem[] {
  const errors = db
    .query<Problem, [number, number]>(
      `SELECT 'tool-errors' AS kind, 'medium' AS severity,
         t.role || ': ' || SUM(c.is_error) || ' failed tool calls of ' || COUNT(*) AS title,
         group_concat(DISTINCT CASE WHEN c.is_error = 1 THEN c.tool END) AS detail,
         t.started_at AS at, o.parent_id AS goal_id, t.id AS turn_id, t.thread_id
       FROM tool_calls c JOIN turns t ON t.id = c.turn_id LEFT JOIN owned_tasks o ON o.id = t.owned_task_id
       WHERE t.started_at >= ?1 GROUP BY t.id HAVING SUM(c.is_error) >= ?2`,
    )
    .all(since, ERROR_CALLS);
  const loops = db
    .query<Problem, [number, number]>(
      `SELECT 'loop' AS kind, 'medium' AS severity,
         t.role || ' repeated ' || c.tool || ' x' || COUNT(*) AS title,
         substr(c.input_json, 1, 200) AS detail, t.started_at AS at, o.parent_id AS goal_id,
         t.id AS turn_id, t.thread_id
       FROM tool_calls c JOIN turns t ON t.id = c.turn_id LEFT JOIN owned_tasks o ON o.id = t.owned_task_id
       WHERE t.started_at >= ?1 GROUP BY t.id, c.tool, c.input_json HAVING COUNT(*) >= ?2`,
    )
    .all(since, REPEAT_CALLS);
  return [...errors, ...loops];
}

/** Items dispatched or resumed more than once: retries, transient failures, re-plans. */
function retriedItems(db: Database, since: number): Problem[] {
  return db
    .query<Problem, [number, number]>(
      `SELECT 'retried' AS kind, 'low' AS severity,
         COALESCE(item_key, '') || ' dispatched ' || dispatch_count || 'x, attempt ' || attempt AS title,
         COALESCE(subject, '') AS detail, last_progress_at AS at, parent_id AS goal_id, NULL AS turn_id, thread_id
       FROM owned_tasks WHERE parent_id IS NOT NULL AND created_at >= ?1 AND (dispatch_count >= ?2 OR attempt >= 1)`,
    )
    .all(since, MANY_DISPATCHES);
}

/** Events that mark trouble: failure, timeout, redelivered wake-ups. */
function troubleEvents(db: Database, since: number): Problem[] {
  return db
    .query<Problem, [number]>(
      `SELECT e.kind AS kind, CASE e.kind WHEN 'failure' THEN 'high' ELSE 'medium' END AS severity,
         e.kind || COALESCE(': ' || json_extract(e.payload, '$.key'), '')
           || COALESCE(' (' || json_extract(e.payload, '$.code') || ')', '') || CASE WHEN e.redelivered > 0 THEN ' (redelivered ' || e.redelivered || 'x)' ELSE '' END AS title,
         e.payload AS detail, e.created_at AS at, e.task_id AS goal_id, NULL AS turn_id, e.thread_id
       FROM thread_events e WHERE e.created_at >= ? AND (e.kind IN ('failure', 'timeout') OR e.redelivered > 0)`,
    )
    .all(since);
}

const RANK = { high: 0, medium: 1, low: 2 } as const;

/** Every detector, high severity first, newest first inside a severity. */
export function listProblems(db: Database, since: number): Problem[] {
  const all = [
    ...heldItems(db, since),
    ...staleItems(db, Date.now()),
    ...badRuns(db, since),
    ...toolTrouble(db, since),
    ...retriedItems(db, since),
    ...troubleEvents(db, since),
  ];
  return all.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.at - a.at);
}
