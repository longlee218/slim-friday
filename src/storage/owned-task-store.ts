import type { Database } from "bun:sqlite";
import type { TaskState } from "../tasks/task-contracts";
import { subjectFromBrief } from "../tasks/task-subject";

/** Statuses of a task that is still the thread's live work (the focus is the newest). */
const LIVE_STATUSES = ["open", "waiting_user", "running"] as const;

/** Row of `owned_tasks` as the code sees it (`ownerRole` = the contract's `ownerAgentId`). */
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
    /** Item fields: the short label (<= 80 chars) and the urgency (0 normal, 10 high, 100 urgent; default 0). */
    subject?: string;
    priority?: number;
    /** Goal rows only: who may change the goal's items (see `StructureOwner`). */
    structureOwner?: StructureOwner;
  },
): void {
  const now = Date.now();
  db.query(
    `INSERT INTO owned_tasks (id, thread_id, owner_role, status, scope, version, correlation_id, created_at,
       last_progress_at, parent_id, item_key, depends_on, location, brief, structure_owner, subject, priority)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    t.structureOwner ?? null,
    t.subject ?? (t.brief ? subjectFromBrief(t.brief) : null),
    t.priority ?? 0,
  );
}

/** How a goal's items change: `lead` (DIRECT / DELEGATE: add / update) or `plan` (PLAN: create_plan / revise_plan). */
export type StructureOwner = "lead" | "plan";

/** Structure owner of a goal; a goal row without the value (or a missing row) counts as `lead`. */
export function structureOwnerOf(db: Database, goalId: string): StructureOwner {
  return cell<string>(db, "SELECT structure_owner AS v FROM owned_tasks WHERE id = ?", goalId) ===
    "plan"
    ? "plan"
    : "lead";
}

/** Hand a goal's structure to `owner` (Orchestrate create_plan on an open goal: lead -> plan). */
export function setStructureOwner(db: Database, goalId: string, owner: StructureOwner): void {
  db.query("UPDATE owned_tasks SET structure_owner = ? WHERE id = ?").run(owner, goalId);
}

/** One column (aliased `v`) of the row selected by an id, or undefined when the row is missing or the value null. */
const cell = <T>(db: Database, sql: string, id: string): T | undefined =>
  db.query<{ v: T | null }, [string]>(sql).get(id)?.v ?? undefined;

/** Task by id, or undefined. */
export function getOwnedTask(db: Database, id: string): TaskState | undefined {
  const row = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM owned_tasks WHERE id = ?`).get(id);
  return row ? toState(row) : undefined;
}

/** Thread a task belongs to, or undefined. */
export function threadOfTask(db: Database, id: string): string | undefined {
  return cell<string>(db, "SELECT thread_id AS v FROM owned_tasks WHERE id = ?", id);
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

/** Sign of life of a task (`last_progress_at` only: no status or version change). A final task is left alone. */
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
  return cell<string>(db, "SELECT owned_task_id AS v FROM turns WHERE id = ?", turnId);
}

/** Startup/shutdown reconcile: flips EVERY running task to `waiting_user` (no process runs it any more). Only safe when no run is alive. */
export function reconcileRunningTasks(db: Database): void {
  db.query(
    "UPDATE owned_tasks SET status = 'waiting_user', version = version + 1, last_progress_at = ? WHERE status = 'running'",
  ).run(Date.now());
}

/** Scope text of a task (goal sentence or item scope), or undefined when the row is missing. */
export function taskScope(db: Database, id: string): string | undefined {
  return cell<string>(db, "SELECT scope AS v FROM owned_tasks WHERE id = ?", id);
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
