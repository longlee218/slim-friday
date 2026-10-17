import type { Database } from "bun:sqlite";
import type { TaskState } from "../tasks/task-contracts";

/** Statuses of a task that is still the thread's live work (the focus is the newest of these). */
const LIVE_STATUSES = ["open", "waiting_user", "running"] as const;

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
    /** Item fields (a goal leaves them out): the goal it belongs to, its key, the keys it waits for. */
    parentId?: string;
    itemKey?: string;
    dependsOn?: string[];
    location?: string;
    brief?: string;
  },
): void {
  const now = Date.now();
  db.query(
    `INSERT INTO owned_tasks (id, thread_id, owner_role, status, scope, version, correlation_id, created_at,
       last_progress_at, parent_id, item_key, depends_on, location, brief)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.threadId,
    t.ownerRole,
    t.status,
    t.scope,
    t.correlationId,
    now,
    now,
    t.parentId ?? null,
    t.itemKey ?? null,
    JSON.stringify(t.dependsOn ?? []),
    t.location ?? null,
    t.brief ?? null,
  );
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

/** Record a sign of life of a task (`last_progress_at` only: no status change, no version bump). A final task is left as it ended. */
export function touchProgress(db: Database, id: string, now = Date.now()): void {
  db.query(
    "UPDATE owned_tasks SET last_progress_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')",
  ).run(now, id);
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

/**
 * Startup/shutdown reconcile. Only safe when no run is alive (startup, drain): it flips EVERY running task. No process runs the work of a `running` task any more, so it waits for the owner
 * (its turn became `interrupted` in the same step).
 */
export function reconcileRunningTasks(db: Database): void {
  db.query(
    "UPDATE owned_tasks SET status = 'waiting_user', version = version + 1, last_progress_at = ? WHERE status = 'running'",
  ).run(Date.now());
}

/** The newest running (or approval-waiting) turn of a task, given as an owned task id or a turn id; undefined when none. */
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

/** Scope text of a task (goal sentence or item scope), or undefined when the row is missing. */
export function taskScope(db: Database, id: string): string | undefined {
  return db
    .query<{ s: string }, [string]>("SELECT scope AS s FROM owned_tasks WHERE id = ?")
    .get(id)?.s;
}

/** Thread and correlation id of a task, or undefined when the row is missing. */
export function taskOrigin(
  db: Database,
  id: string,
): { threadId: string; correlationId: string } | undefined {
  return (
    db
      .query<{ threadId: string; correlationId: string }, [string]>(
        "SELECT thread_id AS threadId, correlation_id AS correlationId FROM owned_tasks WHERE id = ?",
      )
      .get(id) ?? undefined
  );
}

/** Tasks whose status is `running` (id, thread, version). */
export function runningTasks(db: Database): { id: string; threadId: string; version: number }[] {
  return db
    .query<{ id: string; threadId: string; version: number }, []>(
      "SELECT id, thread_id AS threadId, version FROM owned_tasks WHERE status = 'running'",
    )
    .all();
}

/** Rewrite an item the owner's plan edit changed. Only while it has not started (`pending` / `ready`). */
export function rewriteNotStartedItem(
  db: Database,
  id: string,
  f: { brief: string; scope: string; location: string | null; dependsOn: string[] },
): void {
  db.query(
    "UPDATE owned_tasks SET brief = ?, scope = ?, location = ?, depends_on = ? WHERE id = ? AND status IN ('pending', 'ready')",
  ).run(f.brief, f.scope, f.location, JSON.stringify(f.dependsOn), id);
}
