import type { Database } from "bun:sqlite";

/** Goal items in `running` per thread (`/limits` live state), busiest thread first. */
export function runningItemsByThread(db: Database): { threadId: string; count: number }[] {
  return db
    .query<{ threadId: string; count: number }, []>(
      `SELECT thread_id AS threadId, COUNT(*) AS count FROM owned_tasks
       WHERE parent_id IS NOT NULL AND status = 'running' GROUP BY thread_id ORDER BY count DESC`,
    )
    .all();
}
