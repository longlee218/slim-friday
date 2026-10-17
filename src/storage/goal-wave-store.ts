import type { Database } from "bun:sqlite";

/** Open lead goals whose items all ended (at least one item): a goal row `open` that the rolling waves may still continue. */
export function idleOpenGoals(db: Database, ownerRole: string): { id: string; threadId: string }[] {
  return db
    .query<{ id: string; threadId: string }, [string]>(
      `SELECT g.id, g.thread_id AS threadId FROM owned_tasks g
       WHERE g.parent_id IS NULL AND g.owner_role = ? AND g.status = 'open'
         AND EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id)
         AND NOT EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id
                         AND i.status IN ('pending', 'ready', 'running', 'waiting_user', 'blocked'))
       ORDER BY g.rowid DESC`,
    )
    .all(ownerRole);
}

/** Epoch ms a task row was created (0 when unknown). */
export const taskCreatedAt = (db: Database, id: string): number =>
  db.query<{ t: number }, [string]>("SELECT created_at AS t FROM owned_tasks WHERE id = ?").get(id)
    ?.t ?? 0;
