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
export function appendEffect(
  db: Database,
  e: Omit<EffectRow, "createdAt"> & { createdAt?: number },
): boolean {
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
      e.createdAt ?? Date.now(),
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

/** Effects an item's runs recorded, oldest first (the resume prompt lists them: what the interrupted run already did). */
export function effectsOfItem(db: Database, itemId: string): EffectRow[] {
  return db
    .query<EffectRow, [string]>(
      `SELECT id, thread_id AS threadId, goal_id AS goalId, item_id AS itemId, tool, scope,
         granted_by AS grantedBy, result, undo, created_at AS createdAt
       FROM effect_log WHERE item_id = ? ORDER BY created_at, rowid`,
    )
    .all(itemId);
}

/** Audit tool name of the row that records the cwd a worker turn ran in (a resume must use the same cwd; `scope` = the path). */
export const RUN_CWD_TOOL = "RunCwd";

/** Record the cwd of a worker turn (one row per turn; a repeat is a no-op). */
export function recordRunCwd(
  db: Database,
  r: { turnId: string; threadId: string; goalId: string; itemId: string; cwd: string },
): void {
  appendEffect(db, {
    id: `cwd:${r.turnId}`,
    threadId: r.threadId,
    goalId: r.goalId,
    itemId: r.itemId,
    tool: RUN_CWD_TOOL,
    scope: r.cwd,
    grantedBy: "role",
    result: "recorded",
  });
}

/** The cwd a turn ran in, or undefined when none was recorded (the run died before its scope was built). */
export const runCwdOfTurn = (db: Database, turnId: string): string | undefined =>
  effectScope(db, `cwd:${turnId}`);

/** Audit tool name of the rows that record an ApprovePlan ask that ended without a decision (outcome in `result`). */
export const PLAN_ASK_TOOL = "PlanAsk";

/** Newest outcome recorded for an ask of a plan version after `since` (epoch ms), or undefined. */
export function planAskSince(
  db: Database,
  planId: string,
  version: number,
  since: number,
): string | undefined {
  return db
    .query<{ r: string }, [string, string, number]>(
      "SELECT result AS r FROM effect_log WHERE tool = ? AND scope = ? AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(PLAN_ASK_TOOL, `${planId}:${version}`, since)?.r;
}
