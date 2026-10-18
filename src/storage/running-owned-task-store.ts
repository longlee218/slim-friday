import type { Database } from "bun:sqlite";

/* Live-run lookups over `owned_tasks` and `turns`. */

/** Newest running (or approval-waiting) turn of a task, by owned task id or turn id. */
export function runningTurnOfTask(
  db: Database,
  taskId: string,
): { id: string; role: string; threadId: string } | undefined {
  const row = db
    .query<{ id: string; role: string; threadId: string }, [string, string]>(
      `SELECT id, role, thread_id AS threadId FROM turns
         WHERE (owned_task_id = ? OR id = ?) AND status IN ('running', 'waiting_approval')
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(taskId, taskId);
  return row ?? undefined;
}

/** Tasks whose status is `running` (id, thread, version). */
export function runningTasks(db: Database): { id: string; threadId: string; version: number }[] {
  return db
    .query<{ id: string; threadId: string; version: number }, []>(
      "SELECT id, thread_id AS threadId, version FROM owned_tasks WHERE status = 'running'",
    )
    .all();
}
