import type { Database } from "bun:sqlite";

/** Result kinds an item run can end with (typed results land with L2a; the file / excerpt are stored now). */
export type ResultKind =
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "NEEDS_PLANNING"
  | "NEEDS_CLARIFICATION";

/** One item (child) of a goal, as the engine reads it. */
export interface ItemRow {
  /** Task id of the item. */
  id: string;
  /** Goal this item belongs to; null for a goal itself. */
  parentId: string | null;
  /** Key unique within the goal (e.g. "main", "design"); null for a goal. */
  itemKey: string | null;
  /** `owned_tasks.status` (pending, ready, running, ...). */
  status: string;
  /** Item keys of the same goal this item waits for. */
  dependsOn: string[];
  /** Retry number of the item (0 = first run). */
  attempt: number;
  /** How many times the item was dispatched (circuit breaker input). */
  dispatchCount: number;
  /** Role that runs the item (`owned_tasks.owner_role`). */
  ownerRole: string | null;
  /** Location name the item works in; null = not chosen. */
  location: string | null;
  /** Brief given to the worker; null = none. */
  brief: string | null;
  /** Short label (<= 80 chars); null on a row older than the column that has no brief. */
  subject: string | null;
  /** Urgency: 0 normal, 10 high, 100 urgent. */
  priority: number;
  /** Epoch ms of the last status move or sign of life; for a `ready` item, about when it started to wait (scheduler aging). */
  lastProgressAt: number;
  /** Typed result kind of the last run; null until one ended. */
  resultKind: ResultKind | null;
  /** Artifact file of the last run's result (the workspace channel's artifacts dir); null until one ended or when none was stored. */
  resultPath: string | null;
  /** Redacted excerpt (<= 600 chars) of that result; null until one ended. */
  resultExcerpt: string | null;
  /** Redacted report of the last run when it saved no file (the result is not an artifact); null until one ended. */
  resultText: string | null;
}

/** Raw row: `depends_on` is still JSON text. */
type Raw = Omit<ItemRow, "dependsOn"> & { dependsOn: string };

const COLUMNS = `id, parent_id AS parentId, item_key AS itemKey, status, depends_on AS dependsOn, attempt,
  dispatch_count AS dispatchCount, owner_role AS ownerRole, location, brief, subject, priority, last_progress_at AS lastProgressAt, result_kind AS resultKind, result_path AS resultPath,
  result_excerpt AS resultExcerpt, result_text AS resultText`;

/** Raw row to item (JSON `depends_on` parsed; a corrupt value reads as no dependency). */
const toItem = (r: Raw): ItemRow => {
  let deps: unknown = [];
  try {
    deps = JSON.parse(r.dependsOn);
  } catch {
    // corrupt JSON: treated as no dependency
  }
  return { ...r, dependsOn: Array.isArray(deps) ? deps.map(String) : [] };
};

/** Items of a goal in creation order. */
export function childrenOf(db: Database, goalId: string): ItemRow[] {
  return db
    .query<Raw, [string]>(`SELECT ${COLUMNS} FROM owned_tasks WHERE parent_id = ? ORDER BY rowid`)
    .all(goalId)
    .map(toItem);
}

/** Id of the goal an item belongs to, or undefined for a goal / unknown id. */
export function goalOf(db: Database, itemId: string): string | undefined {
  return (
    db
      .query<{ g: string | null }, [string]>("SELECT parent_id AS g FROM owned_tasks WHERE id = ?")
      .get(itemId)?.g ?? undefined
  );
}

/** One item by id, or undefined. */
export function getItem(db: Database, id: string): ItemRow | undefined {
  const row = db.query<Raw, [string]>(`SELECT ${COLUMNS} FROM owned_tasks WHERE id = ?`).get(id);
  return row ? toItem(row) : undefined;
}

/** Count one dispatch of an item (circuit breaker input); returns the new count. */
export function bumpDispatch(db: Database, id: string): number {
  db.query("UPDATE owned_tasks SET dispatch_count = dispatch_count + 1 WHERE id = ?").run(id);
  return getItem(db, id)?.dispatchCount ?? 0;
}

/**
 * Record the result of a finished run: the file it saved itself (path, null = none), the redacted excerpt and, when it saved no
 * file, its redacted report as `text` (no artifact is written for a summary); plus the kind when typed.
 */
export function setTaskResult(
  db: Database,
  id: string,
  r: { path: string | null; excerpt: string; text?: string | null; kind?: ResultKind },
): void {
  db.query(
    "UPDATE owned_tasks SET result_path = ?, result_excerpt = ?, result_text = ?, result_kind = COALESCE(?, result_kind) WHERE id = ?",
  ).run(r.path, r.excerpt, r.text ?? null, r.kind ?? null, id);
}

/** Item statuses that still count as work in progress. */
const OPEN_ITEM = "('pending', 'ready', 'running', 'waiting_user', 'blocked')";

/**
 * Id of the thread's newest goal of `ownerRole` (a goal = a row without a parent) with status `open` and at least
 * one unfinished item, or no item yet but created after `pendingPlansSince` (a PLAN goal whose plan waits for the owner or was rejected: the lead
 * re-plans in it; older than the limit it is closed by the expiry sweep), or a plan waiting for the owner created after `pendingPlansSince`.
 */
export function openGoalId(
  db: Database,
  threadId: string,
  ownerRole: string,
  pendingPlansSince: number,
): string | undefined {
  return db
    .query<{ id: string }, [string, string, number, number]>(
      `SELECT g.id FROM owned_tasks g
       WHERE g.thread_id = ? AND g.parent_id IS NULL AND g.owner_role = ? AND g.status = 'open'
         AND ((NOT EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id) AND g.created_at > ?)
              OR EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id AND i.status IN ${OPEN_ITEM})
              OR EXISTS (SELECT 1 FROM work_plans p WHERE p.goal_id = g.id AND p.status IN ('draft', 'valid') AND p.created_at > ?)
              )
       ORDER BY g.rowid DESC LIMIT 1`,
    )
    .get(threadId, ownerRole, pendingPlansSince, pendingPlansSince)?.id;
}

/** Open goals of `ownerRole` with no item that were created before `before`: a PLAN goal whose plan nobody approved or re-planned. */
export function staleEmptyGoals(
  db: Database,
  ownerRole: string,
  before: number,
): { id: string; threadId: string }[] {
  return db
    .query<{ id: string; threadId: string }, [string, number]>(
      `SELECT g.id, g.thread_id AS threadId FROM owned_tasks g
       WHERE g.parent_id IS NULL AND g.owner_role = ? AND g.status = 'open' AND g.created_at <= ?
         AND NOT EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id)
         AND NOT EXISTS (SELECT 1 FROM work_plans p WHERE p.goal_id = g.id AND p.status IN ('draft', 'valid'))`,
    )
    .all(ownerRole, before);
}

/** Newest goal of the thread (any status) owned by `ownerRole`, or undefined. */
export function latestGoalId(
  db: Database,
  threadId: string,
  ownerRole: string,
): string | undefined {
  return db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM owned_tasks WHERE thread_id = ? AND parent_id IS NULL AND owner_role = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(threadId, ownerRole)?.id;
}

/** Ids of the goals of a thread (owned tasks without a parent). */
export const goalIdsOfThread = (db: Database, threadId: string): string[] =>
  db
    .query<{ id: string }, [string]>(
      "SELECT id FROM owned_tasks WHERE thread_id = ? AND parent_id IS NULL",
    )
    .all(threadId)
    .map((r) => r.id);

/** Count one automatic resume of an item (the retry number `attempt`); returns the new count. */
export function bumpAttempt(db: Database, id: string): number {
  db.query("UPDATE owned_tasks SET attempt = attempt + 1 WHERE id = ?").run(id);
  return getItem(db, id)?.attempt ?? 0;
}

/** Give an item a fresh automatic-resume budget (the lead's `Orchestrate retry`). */
export function resetAttempt(db: Database, id: string): void {
  db.query("UPDATE owned_tasks SET attempt = 0 WHERE id = ?").run(id);
}

/** Record the typed result kind of an item without touching its result file (a failure that had no typed report). */
export function setResultKind(db: Database, id: string, kind: ResultKind): void {
  db.query("UPDATE owned_tasks SET result_kind = ? WHERE id = ?").run(kind, id);
}

/** Goal items (children) whose status is `running`: at boot no process runs them, so they are resumed or held. */
export function runningGoalItems(db: Database): ItemRow[] {
  return db
    .query<Raw, []>(
      `SELECT ${COLUMNS} FROM owned_tasks WHERE parent_id IS NOT NULL AND status = 'running' ORDER BY rowid`,
    )
    .all()
    .map(toItem);
}

/**
 * A held item: any `blocked` item (a failed run, a budget hit, BLOCKED / NEEDS_PLANNING). It is stopped and waits for the
 * lead's `Orchestrate retry` or `Orchestrate cancel`; `resultKind` tells why (FAILED = a failure, else the worker's own report).
 */
export const isHeld = (it: Pick<ItemRow, "status">): boolean => it.status === "blocked";

/** Clear the typed result kind (a retried item is no longer held: `isHeld` must not read the old FAILED). */
export function clearResultKind(db: Database, id: string): void {
  db.query("UPDATE owned_tasks SET result_kind = NULL WHERE id = ?").run(id);
}

/** Threads with a goal item waiting in `ready` (resumed by shutdown or boot, or just queued): boot dispatches them. */
export function threadsWithReadyItems(db: Database): string[] {
  return db
    .query<{ t: string }, []>(
      "SELECT DISTINCT thread_id AS t FROM owned_tasks WHERE parent_id IS NOT NULL AND status = 'ready'",
    )
    .all()
    .map((r) => r.t);
}
