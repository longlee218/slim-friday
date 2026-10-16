import type { Database } from "bun:sqlite";

/** One side effect a grant allowed (audit row; never rewritten). */
export interface EffectRow {
  id: string;
  threadId: string;
  goalId?: string;
  itemId?: string;
  /** Tool or action name. */
  tool: string;
  /** What the grant covered (path, repo, command class). */
  scope: string;
  /** Who allowed it: `owner`, `plan`, `role`. */
  grantedBy: string;
  /** Short outcome text (redacted by the caller). */
  result: string;
  /** How to undo it, when known. */
  undo?: string;
  createdAt: number;
}

/** Append one effect. Same `id` twice = no-op (idempotent). Returns true when a row was written. */
export function appendEffect(db: Database, e: Omit<EffectRow, "createdAt">): boolean {
  const res = db
    .query(
      `INSERT OR IGNORE INTO effect_log (id, thread_id, goal_id, item_id, tool, scope, granted_by, result, undo,
         created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.id,
      e.threadId,
      e.goalId ?? null,
      e.itemId ?? null,
      e.tool,
      e.scope,
      e.grantedBy,
      e.result,
      e.undo ?? null,
      Date.now(),
    );
  return res.changes === 1;
}

/** Effects of a goal, oldest first. */
export function effectsOfGoal(db: Database, goalId: string): EffectRow[] {
  return db
    .query<EffectRow, [string]>(
      `SELECT id, thread_id AS threadId, goal_id AS goalId, item_id AS itemId, tool, scope,
         granted_by AS grantedBy, result, undo, created_at AS createdAt
       FROM effect_log WHERE goal_id = ? ORDER BY created_at, rowid`,
    )
    .all(goalId);
}

/** Stored result of an effect key, or undefined when the effect never ran. */
export function effectResult(db: Database, key: string): string | undefined {
  return db
    .query<{ r: string }, [string]>("SELECT result AS r FROM effect_log WHERE id = ?")
    .get(key)?.r;
}

/** Audit tool name of the row that pins a goal's push remote (its `scope` is the URL hash). */
export const REMOTE_PIN_TOOL = "RemotePin";

/** `scope` of an effect row by id (a remote pin's URL hash, a dispatch's stored grants), or undefined when no such row. */
export function effectScope(db: Database, id: string): string | undefined {
  return db.query<{ scope: string }, [string]>("SELECT scope FROM effect_log WHERE id = ?").get(id)
    ?.scope;
}
