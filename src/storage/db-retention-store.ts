import type { Database } from "bun:sqlite";
import { OPEN_ITEM } from "./owned-item-store";

/* Garbage collection of finished history: rows that only the audit, `/status` and the ops dashboard read.
   Work in progress is never touched: a running turn has no `ended_at`, an undelivered event is kept, and a turn of an
   item that is still open is kept so a later `Orchestrate retry` can resume its session. */

/** Ended turns older than the cutoff whose item (if any) is finished. `$cutoff` is bound by the caller. */
const OLD_TURNS = `SELECT id FROM turns WHERE ended_at IS NOT NULL AND ended_at < $cutoff
  AND (owned_task_id IS NULL OR owned_task_id NOT IN (SELECT id FROM owned_tasks WHERE status IN ${OPEN_ITEM}))`;

/** Closed goals (a goal = a row without a parent) with no progress since the cutoff and no open item. */
const OLD_GOALS = `SELECT id FROM owned_tasks g WHERE g.parent_id IS NULL AND g.status <> 'open'
  AND g.last_progress_at < $cutoff
  AND NOT EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id AND i.status IN ${OPEN_ITEM})`;

/** Delete statements in dependency order (children before the rows their filter reads). */
const STEPS: [table: string, sql: string][] = [
  [
    "tool_calls",
    `DELETE FROM tool_calls WHERE turn_id IN (${OLD_TURNS})
       OR run_id IN (SELECT id FROM runs WHERE turn_id IN (${OLD_TURNS}))`,
  ],
  ["runs", `DELETE FROM runs WHERE turn_id IN (${OLD_TURNS})`],
  ["approvals", `DELETE FROM approvals WHERE turn_id IN (${OLD_TURNS})`],
  ["turns", `DELETE FROM turns WHERE id IN (${OLD_TURNS})`],
  [
    "thread_events",
    "DELETE FROM thread_events WHERE delivered_at IS NOT NULL AND created_at < $cutoff",
  ],
  ["effect_log", "DELETE FROM effect_log WHERE created_at < $cutoff"],
  [
    "task_messages_fts",
    `DELETE FROM task_messages_fts WHERE message_id IN
       (SELECT id FROM task_messages WHERE goal_id IN (${OLD_GOALS}))`,
  ],
  ["task_messages", `DELETE FROM task_messages WHERE goal_id IN (${OLD_GOALS})`],
  [
    "item_questions",
    `DELETE FROM item_questions WHERE item_id IN (SELECT id FROM owned_tasks WHERE parent_id IN (${OLD_GOALS}))`,
  ],
  ["work_plans", `DELETE FROM work_plans WHERE goal_id IN (${OLD_GOALS})`],
  ["owned_tasks", `DELETE FROM owned_tasks WHERE parent_id IN (${OLD_GOALS})`],
  ["owned_tasks", `DELETE FROM owned_tasks WHERE id IN (${OLD_GOALS})`],
];

/** Ids of the goals `pruneOldHistory(db, cutoff)` is about to delete (the caller removes their files first). */
export function oldGoalIds(db: Database, cutoff: number): string[] {
  return db
    .query<{ id: string }, { $cutoff: number }>(OLD_GOALS)
    .all({ $cutoff: cutoff })
    .map((r) => r.id);
}

/** Delete finished history older than `cutoff` (ms epoch) in one transaction; returns deleted rows per table. */
export function pruneOldHistory(db: Database, cutoff: number): Record<string, number> {
  const counts: Record<string, number> = {};
  db.transaction(() => {
    for (const [table, sql] of STEPS)
      counts[table] = (counts[table] ?? 0) + db.query(sql).run({ $cutoff: cutoff }).changes;
  })();
  return counts;
}
