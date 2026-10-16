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
  /** Typed result kind of the last run; null until one ended. */
  resultKind: ResultKind | null;
  /** Result file of the last run (under AGENT_HOME/goals); null until one ended. */
  resultPath: string | null;
  /** Redacted excerpt (<= 600 chars) of that result; null until one ended. */
  resultExcerpt: string | null;
}

/** Raw row: `depends_on` is still JSON text. */
type Raw = Omit<ItemRow, "dependsOn"> & { dependsOn: string };

const COLUMNS = `id, parent_id AS parentId, item_key AS itemKey, status, depends_on AS dependsOn, attempt,
  dispatch_count AS dispatchCount, owner_role AS ownerRole, location, brief, result_kind AS resultKind, result_path AS resultPath,
  result_excerpt AS resultExcerpt`;

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

/** Record where the result of a finished run lives: file path + redacted excerpt (+ kind when typed). */
export function setTaskResult(
  db: Database,
  id: string,
  r: { path: string; excerpt: string; kind?: ResultKind },
): void {
  db.query(
    "UPDATE owned_tasks SET result_path = ?, result_excerpt = ?, result_kind = COALESCE(?, result_kind) WHERE id = ?",
  ).run(r.path, r.excerpt, r.kind ?? null, id);
}

/** Item statuses that still count as work in progress. */
const OPEN_ITEM = "('pending', 'ready', 'running', 'waiting_user', 'blocked')";

/**
 * Id of the thread's newest goal of `ownerRole` (a goal = a row without a parent) with status `open` and at least
 * one unfinished item (or no item yet), or a plan waiting for the owner created after `pendingPlansSince`.
 */
export function openGoalId(
  db: Database,
  threadId: string,
  ownerRole: string,
  pendingPlansSince: number,
): string | undefined {
  return db
    .query<{ id: string }, [string, string, number]>(
      `SELECT g.id FROM owned_tasks g
       WHERE g.thread_id = ? AND g.parent_id IS NULL AND g.owner_role = ? AND g.status = 'open'
         AND (NOT EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id)
              OR EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id AND i.status IN ${OPEN_ITEM})
              OR EXISTS (SELECT 1 FROM work_plans p WHERE p.goal_id = g.id AND p.status IN ('draft', 'valid') AND p.created_at > ?))
       ORDER BY g.rowid DESC LIMIT 1`,
    )
    .get(threadId, ownerRole, pendingPlansSince)?.id;
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
