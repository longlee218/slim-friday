import type { Database } from "bun:sqlite";
import { teammateTurnsInWindow, TURN_SELECT, type TurnRow } from "./turn-rows";

/** Goal = an `owned_tasks` row with no parent; its items are the rows whose `parent_id` is the goal. */
interface GoalRow {
  id: string;
  thread_id: string;
  status: string;
  subject: string | null;
  scope: string;
  created_at: number;
  last_progress_at: number;
  thread_title: string | null;
  workspace: string | null;
  items: number;
  done: number;
  held: number;
  running: number;
  worker_cost: number;
  end_at: number;
}

/** Latest activity of a goal: its own progress, its items' progress, the end of its worker runs. */
const GOAL_END = `MAX(g.last_progress_at,
  COALESCE((SELECT MAX(i.last_progress_at) FROM owned_tasks i WHERE i.parent_id = g.id), 0),
  COALESCE((SELECT MAX(t.ended_at) FROM turns t JOIN owned_tasks i ON i.id = t.owned_task_id WHERE i.parent_id = g.id), 0))`;

const GOAL_SELECT = `
  SELECT g.id, g.thread_id, g.status, g.subject, substr(g.scope, 1, 400) AS scope, g.created_at, g.last_progress_at,
    th.title AS thread_title, th.workspace,
    (SELECT COUNT(*) FROM owned_tasks i WHERE i.parent_id = g.id) AS items,
    (SELECT COUNT(*) FROM owned_tasks i WHERE i.parent_id = g.id AND i.status = 'completed') AS done,
    (SELECT COUNT(*) FROM owned_tasks i WHERE i.parent_id = g.id AND i.status IN ('blocked','failed')) AS held,
    (SELECT COUNT(*) FROM owned_tasks i WHERE i.parent_id = g.id AND i.status = 'running') AS running,
    (SELECT COALESCE(SUM(r.cost_usd), 0) FROM runs r JOIN turns t ON t.id = r.turn_id
       JOIN owned_tasks i ON i.id = t.owned_task_id WHERE i.parent_id = g.id) AS worker_cost,
    ${GOAL_END} AS end_at
  FROM owned_tasks g LEFT JOIN threads th ON th.thread_id = g.thread_id
  WHERE g.parent_id IS NULL`;

/** Open goals end "now" so their teammate window keeps growing. */
function windowEnd(g: GoalRow): number {
  return g.status === "open" ? Date.now() : g.end_at;
}

/** Sum of a teammate window's run costs. */
function teammateCost(db: Database, g: GoalRow): number {
  return teammateTurnsInWindow(db, g.thread_id, g.created_at, windowEnd(g)).reduce(
    (s, t) => s + (t.cost_usd ?? 0),
    0,
  );
}

/** Goals created since `since`, newest first, with item counts and cost split worker / teammate. */
export function listGoals(db: Database, since: number) {
  const rows = db
    .query<GoalRow, [number]>(`${GOAL_SELECT} AND g.created_at >= ? ORDER BY g.created_at DESC`)
    .all(since);
  return rows.map((g) => ({ ...g, teammate_cost: teammateCost(db, g) }));
}

/** Everything one goal screen needs: goal, plans, items, every run on a time axis, events, effects. */
export function goalDetail(db: Database, id: string) {
  const goal = db.query<GoalRow, [string]>(`${GOAL_SELECT} AND g.id = ?`).get(id);
  if (!goal) return null;
  const end = windowEnd(goal);
  const items = db
    .query(
      `SELECT id, item_key, owner_role, status, subject, substr(brief, 1, 2000) AS brief, depends_on, attempt,
         dispatch_count, priority, location, result_kind, result_excerpt, created_at, last_progress_at
       FROM owned_tasks WHERE parent_id = ? ORDER BY created_at, rowid`,
    )
    .all(id);
  const workerTurns = db
    .query<TurnRow, [string]>(
      `${TURN_SELECT} WHERE o.parent_id = ? ORDER BY t.started_at`,
    )
    .all(id);
  const teammateTurns = teammateTurnsInWindow(db, goal.thread_id, goal.created_at, end);
  const plans = db
    .query(
      `SELECT id, version, status, strategy, objective, budget_usd, reason, created_at, approved_at
       FROM work_plans WHERE goal_id = ? ORDER BY version`,
    )
    .all(id);
  // Events of the goal (task_id) or its items, plus owner messages inside its window.
  const events = db
    .query(
      `SELECT seq, kind, item_id, payload, created_at FROM thread_events
       WHERE thread_id = ?1 AND (task_id = ?2 OR item_id IN (SELECT id FROM owned_tasks WHERE parent_id = ?2)
         OR (kind = 'owner_message' AND created_at BETWEEN ?3 AND ?4))
       ORDER BY seq`,
    )
    .all(goal.thread_id, id, goal.created_at - 60_000, end);
  const effects = db
    .query(
      `SELECT id, item_id, tool, scope, granted_by, result, created_at FROM effect_log
       WHERE goal_id = ? ORDER BY created_at`,
    )
    .all(id);
  const teammate_cost = teammateTurns.reduce((s, t) => s + (t.cost_usd ?? 0), 0);
  return { goal: { ...goal, teammate_cost }, items, turns: [...teammateTurns, ...workerTurns], plans, events, effects };
}
