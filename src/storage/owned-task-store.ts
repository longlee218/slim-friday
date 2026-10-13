import type { Database } from "bun:sqlite";
import type { TaskState } from "../routing/routing-contracts";

/** Statuses of a task that is still the thread's live work (the focus is the newest of these). */
export const LIVE_STATUSES = ["open", "waiting_user", "running"] as const;

/** Row of `owned_tasks` as the code sees it (same shape as the routing contract, `ownerAgentId` = owner role). */
type Row = {
  id: string;
  threadId: string;
  ownerRole: string | null;
  status: TaskState["status"];
  scope: string;
  version: number;
  correlationId: string;
  lastProgressAt: number;
};

const COLUMNS = `id, thread_id AS threadId, owner_role AS ownerRole, status, scope, version,
  correlation_id AS correlationId, last_progress_at AS lastProgressAt`;

/** Task as the routing contract wants it (time as ISO string). */
const toState = (r: Row): TaskState => ({
  taskId: r.id,
  ownerAgentId: r.ownerRole,
  status: r.status,
  scope: r.scope,
  lastProgressAt: new Date(r.lastProgressAt).toISOString(),
  version: r.version,
  correlationId: r.correlationId,
});

/** Insert a task at version 0. `scope` must already be redacted and clipped by the caller. */
export function insertOwnedTask(
  db: Database,
  t: {
    id: string;
    threadId: string;
    ownerRole: string;
    status: TaskState["status"];
    scope: string;
    correlationId: string;
  },
): void {
  const now = Date.now();
  db.query(
    `INSERT INTO owned_tasks (id, thread_id, owner_role, status, scope, version, correlation_id, created_at, last_progress_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(t.id, t.threadId, t.ownerRole, t.status, t.scope, t.correlationId, now, now);
}

/** Task by id, or undefined. */
export function getOwnedTask(db: Database, id: string): TaskState | undefined {
  const row = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM owned_tasks WHERE id = ?`).get(id);
  return row ? toState(row) : undefined;
}

/** Thread a task belongs to, or undefined. */
export function threadOfTask(db: Database, id: string): string | undefined {
  return db
    .query<{ t: string }, [string]>("SELECT thread_id AS t FROM owned_tasks WHERE id = ?")
    .get(id)?.t;
}

/** The thread's focus: its newest live task (open / waiting_user / running), or undefined. */
export function activeOwnedTask(db: Database, threadId: string): TaskState | undefined {
  const row = db
    .query<Row, [string]>(
      `SELECT ${COLUMNS} FROM owned_tasks
       WHERE thread_id = ? AND status IN ('${LIVE_STATUSES.join("', '")}')
       ORDER BY last_progress_at DESC, rowid DESC LIMIT 1`,
    )
    .get(threadId);
  return row ? toState(row) : undefined;
}

/**
 * Compare-and-set update: applies `patch` and bumps `version` only when the stored version is still
 * `expectedVersion`. Returns false when another writer got there first (nothing changed).
 */
export function casUpdateTask(
  db: Database,
  id: string,
  expectedVersion: number,
  patch: { status?: TaskState["status"]; ownerRole?: string },
): boolean {
  const res = db
    .query(
      `UPDATE owned_tasks SET status = COALESCE(?, status), owner_role = COALESCE(?, owner_role),
         version = version + 1, last_progress_at = ?
       WHERE id = ? AND version = ?`,
    )
    .run(patch.status ?? null, patch.ownerRole ?? null, Date.now(), id, expectedVersion);
  return res.changes === 1;
}

/** Link a turn to the task it works on. */
export function linkTurn(db: Database, turnId: string, taskId: string): void {
  db.query("UPDATE turns SET owned_task_id = ? WHERE id = ?").run(taskId, turnId);
}

/** Id of the task a turn is linked to, or undefined (foreground / side-lane turn, or no row). */
export function ownedTaskOfTurn(db: Database, turnId: string): string | undefined {
  return (
    db
      .query<{ id: string | null }, [string]>("SELECT owned_task_id AS id FROM turns WHERE id = ?")
      .get(turnId)?.id ?? undefined
  );
}

/** Newest turn of a task with the session it recorded (what a continuation resumes), or undefined. */
export function lastTurnOfTask(
  db: Database,
  taskId: string,
):
  | {
      id: string;
      status: string;
      repo: string;
      sessionId: string | null;
      cwd: string | null;
    }
  | undefined {
  return (
    db
      .query<
        { id: string; status: string; repo: string; sessionId: string | null; cwd: string | null },
        [string]
      >(
        `SELECT id, status, repo, session_id AS sessionId, session_cwd AS cwd FROM turns
         WHERE owned_task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId) ?? undefined
  );
}

/**
 * Startup/shutdown reconcile. Only safe when no run is alive (startup, drain): it flips EVERY running task. No process runs the work of a `running` task any more, so it waits for the owner
 * (its turn became `interrupted` in the same step).
 */
export function reconcileRunningTasks(db: Database): void {
  db.query(
    "UPDATE owned_tasks SET status = 'waiting_user', version = version + 1, last_progress_at = ? WHERE status = 'running'",
  ).run(Date.now());
}
