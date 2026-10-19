import type { Database } from "bun:sqlite";

/* Reads and edits of goal items for the lead's `add` / `update` / `get` / `search` and the planner's `get` / `search`:
   the not-started edit, the thread's items as search candidates, an item's newest events. SQL lives here only. */

/** Rewrite an item the owner's plan edit changed, only while it has not started (`pending` / `ready`). */
export function rewriteNotStartedItem(
  db: Database,
  id: string,
  f: {
    brief: string;
    scope: string;
    location: string | null;
    dependsOn: string[];
    /** Absent = keep the stored value. */
    subject?: string;
    priority?: number;
  },
): void {
  db.query(
    "UPDATE owned_tasks SET brief = ?, scope = ?, location = ?, depends_on = ?, subject = COALESCE(?, subject), priority = COALESCE(?, priority) WHERE id = ? AND status IN ('pending', 'ready')",
  ).run(
    f.brief,
    f.scope,
    f.location,
    JSON.stringify(f.dependsOn),
    f.subject ?? null,
    f.priority ?? null,
    id,
  );
}

/** What `editNotStartedItem` may change; an absent field stays as it is. */
export interface ItemEdit {
  subject?: string;
  brief?: string;
  /** Scope text that follows a new brief (the caller clips and redacts it). */
  scope?: string;
  priority?: number;
  ownerRole?: string;
  dependsOn?: string[];
  /** Status that follows a new dependency list: `pending` (waits) or `ready` (nothing left to wait for). */
  status?: "pending" | "ready";
}

/**
 * Edit an item that has not started, in one statement guarded by its status (`pending` / `ready`): a run that started
 * meanwhile makes this a no-op. Returns false when the guard did not match (nothing changed). Bumps the version so a
 * concurrent status move (compare-and-set) loses.
 */
export function editNotStartedItem(db: Database, id: string, e: ItemEdit): boolean {
  const sets: string[] = [];
  const args: (string | number)[] = [];
  const set = (col: string, v: string | number | undefined) => {
    if (v === undefined) return;
    sets.push(`${col} = ?`);
    args.push(v);
  };
  set("subject", e.subject);
  set("brief", e.brief);
  set("scope", e.scope);
  set("priority", e.priority);
  set("owner_role", e.ownerRole);
  set("depends_on", e.dependsOn && JSON.stringify(e.dependsOn));
  set("status", e.status);
  if (!sets.length) return false;
  const res = db
    .query(
      `UPDATE owned_tasks SET ${sets.join(", ")}, version = version + 1, last_progress_at = ?
       WHERE id = ? AND status IN ('pending', 'ready')`,
    )
    .run(...args, Date.now(), id);
  return res.changes === 1;
}

/** A goal or item of a thread as a search candidate. */
export interface TaskCandidate {
  id: string;
  /** Goal the row belongs to; null for a goal row. */
  goalId: string | null;
  itemKey: string | null;
  status: string;
  /** Subject of an item; for a goal the goal sentence. */
  subject: string;
  /** Brief of an item (empty for a goal). */
  brief: string;
  createdAt: number;
  /** Epoch ms of the last status move (`last_progress_at`): for a completed item, when it completed. */
  endedAt: number;
}

/** Most candidate rows one search reads (the newest first): a thread has far fewer. */
const CANDIDATES_MAX = 500;

/** The thread's goals and items, newest first (at most `CANDIDATES_MAX`). */
export function taskCandidates(db: Database, threadId: string): TaskCandidate[] {
  return db
    .query<TaskCandidate, [string, number]>(
      `SELECT id, parent_id AS goalId, item_key AS itemKey, status,
         COALESCE(subject, scope) AS subject, COALESCE(brief, '') AS brief, created_at AS createdAt,
         last_progress_at AS endedAt
       FROM owned_tasks WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?`,
    )
    .all(threadId, CANDIDATES_MAX);
}

/** The newest `n` events of an item (oldest first within them): kind, payload JSON, time. */
export function recentItemEvents(
  db: Database,
  itemId: string,
  n: number,
): { kind: string; payload: string; createdAt: number }[] {
  return db
    .query<{ kind: string; payload: string; createdAt: number }, [string, number]>(
      `SELECT kind, payload, created_at AS createdAt FROM (
         SELECT seq, kind, payload, created_at FROM thread_events WHERE item_id = ? ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq`,
    )
    .all(itemId, n);
}
