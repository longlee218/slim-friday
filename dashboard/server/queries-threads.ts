import type { Database } from "bun:sqlite";
import { TURN_SELECT, type TurnRow } from "./turn-rows";

/** Threads with activity since `since`: run count, cost, goals, last activity. */
export function listThreads(db: Database, since: number) {
  return db
    .query(
      `SELECT th.thread_id, th.title, th.workspace, th.created_at,
         (SELECT COUNT(*) FROM turns t WHERE t.thread_id = th.thread_id) AS runs,
         (SELECT COALESCE(SUM(r.cost_usd), 0) FROM runs r JOIN turns t ON t.id = r.turn_id
            WHERE t.thread_id = th.thread_id) AS cost_usd,
         (SELECT COUNT(*) FROM owned_tasks g WHERE g.thread_id = th.thread_id AND g.parent_id IS NULL) AS goals,
         (SELECT COUNT(*) FROM turns t WHERE t.thread_id = th.thread_id AND t.ended_at IS NULL) AS running,
         MAX(th.updated_at, COALESCE((SELECT MAX(t.started_at) FROM turns t WHERE t.thread_id = th.thread_id), 0))
           AS last_at
       FROM threads th WHERE last_at >= ? ORDER BY last_at DESC`,
    )
    .all(since);
}

/**
 * A thread as one ordered stream: every event and every run start, so a replay reads
 * "owner said X -> lead ran -> dispatched Y -> Y reported" top to bottom.
 */
export function threadReplay(db: Database, threadId: string) {
  const thread = db
    .query("SELECT thread_id, title, workspace, created_at FROM threads WHERE thread_id = ?")
    .get(threadId);
  if (!thread) return null;
  const events = db
    .query<{ seq: number; kind: string; item_id: string | null; task_id: string | null; payload: string; created_at: number; redelivered: number }, [string]>(
      `SELECT seq, kind, item_id, task_id, payload, created_at, redelivered FROM thread_events
       WHERE thread_id = ? ORDER BY seq`,
    )
    .all(threadId);
  const turns = db
    .query<TurnRow, [string]>(`${TURN_SELECT} WHERE t.thread_id = ? ORDER BY t.started_at`)
    .all(threadId);
  const goals = db
    .query(
      `SELECT id, status, subject, substr(scope, 1, 200) AS scope, created_at FROM owned_tasks
       WHERE thread_id = ? AND parent_id IS NULL ORDER BY created_at`,
    )
    .all(threadId);
  const stream = [
    ...events.map((e) => ({ type: "event" as const, at: e.created_at, event: e })),
    ...turns.map((t) => ({ type: "run" as const, at: t.started_at, run: t })),
  ].sort((a, b) => a.at - b.at);
  return { thread, goals, stream };
}
