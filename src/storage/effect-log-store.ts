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
  /** Epoch ms the grant stops being valid. */
  expiresAt?: number;
  createdAt: number;
}

/** Append one effect. Same `id` twice = no-op (idempotent). Returns true when a row was written. */
export function appendEffect(db: Database, e: Omit<EffectRow, "createdAt">): boolean {
  const res = db
    .query(
      `INSERT OR IGNORE INTO effect_log (id, thread_id, goal_id, item_id, tool, scope, granted_by, result, undo,
         expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      e.expiresAt ?? null,
      Date.now(),
    );
  return res.changes === 1;
}

/** Effects of a goal, oldest first. */
export function effectsOfGoal(db: Database, goalId: string): EffectRow[] {
  return db
    .query<EffectRow, [string]>(
      `SELECT id, thread_id AS threadId, goal_id AS goalId, item_id AS itemId, tool, scope,
         granted_by AS grantedBy, result, undo, expires_at AS expiresAt, created_at AS createdAt
       FROM effect_log WHERE goal_id = ? ORDER BY created_at, rowid`,
    )
    .all(goalId);
}
