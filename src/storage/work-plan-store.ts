import type { Database } from "bun:sqlite";

/** Lifecycle of a work plan version. */
export type PlanStatus = "draft" | "valid" | "approved" | "superseded" | "rejected";

/** A stored work plan version (JSON columns are kept as text: the plan schema belongs to a later phase). */
export interface WorkPlanRow {
  /** Plan id (stable across versions). */
  id: string;
  /** Version number, 1 for the first; a new version supersedes the older one. */
  version: number;
  /** Goal (owned task) the plan is for. */
  goalId: string;
  /** Lifecycle state of this version. */
  status: PlanStatus;
  /** How the work is split (strategy name chosen by the planner). */
  strategy: string;
  /** What the goal must achieve, one paragraph. */
  objective: string;
  /** Plan text / items as written by the planner. */
  body: string;
  /** JSON array of acceptance criteria. */
  acceptance: string;
  /** JSON object: limits the run must stay inside (tools, locations, ...). */
  envelope: string;
  /** Budget cap for the whole plan, USD; null = none set. */
  budgetUsd: number | null;
  /** How the result is handed over (merge / pr / keep); null = not decided. */
  deliveryMode: string | null;
  /** Why the version was rejected or superseded; null otherwise. */
  reason: string | null;
  /** Epoch ms the version was stored. */
  createdAt: number;
  /** Epoch ms the owner approved it; null until approved. */
  approvedAt: number | null;
}

const COLUMNS = `id, version, goal_id AS goalId, status, strategy, objective, body, acceptance, envelope,
  budget_usd AS budgetUsd, delivery_mode AS deliveryMode, reason, created_at AS createdAt,
  approved_at AS approvedAt`;

/** Insert a new plan version (`version` = previous latest + 1, 1 for the first). Returns the stored row. */
export function insertPlanVersion(
  db: Database,
  p: Omit<WorkPlanRow, "version" | "createdAt" | "approvedAt" | "status"> & { status?: PlanStatus },
): WorkPlanRow {
  // Read latest + insert in one transaction: two writers never take the same version.
  const version = db.transaction(() => {
    const next = (latestPlan(db, p.id)?.version ?? 0) + 1;
    db.query(
      `INSERT INTO work_plans (id, version, goal_id, status, strategy, objective, body, acceptance, envelope,
       budget_usd, delivery_mode, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id,
      next,
      p.goalId,
      p.status ?? "draft",
      p.strategy,
      p.objective,
      p.body,
      p.acceptance,
      p.envelope,
      p.budgetUsd,
      p.deliveryMode,
      p.reason,
      Date.now(),
    );
    return next;
  })();
  const row = getPlan(db, p.id, version);
  if (!row) throw new Error(`work plan ${p.id} v${version} missing right after insert`);
  return row;
}

/** One plan version, or undefined. */
export function getPlan(db: Database, id: string, version: number): WorkPlanRow | undefined {
  return (
    db
      .query<WorkPlanRow, [string, number]>(
        `SELECT ${COLUMNS} FROM work_plans WHERE id = ? AND version = ?`,
      )
      .get(id, version) ?? undefined
  );
}

/** Highest version of a plan, or undefined. */
export function latestPlan(db: Database, id: string): WorkPlanRow | undefined {
  return (
    db
      .query<WorkPlanRow, [string]>(
        `SELECT ${COLUMNS} FROM work_plans WHERE id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(id) ?? undefined
  );
}

/**
 * Compare-and-set of a plan version's status: moves `from -> to` only while the row still has `from`
 * (stamps `approved_at` on `approved`). Returns false when another writer got there first.
 */
export function casPlanStatus(
  db: Database,
  id: string,
  version: number,
  from: PlanStatus,
  to: PlanStatus,
  reason?: string,
): boolean {
  const res = db
    .query(
      `UPDATE work_plans SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END,
         reason = COALESCE(?, reason)
       WHERE id = ? AND version = ? AND status = ?`,
    )
    .run(to, to, Date.now(), reason ?? null, id, version, from);
  return res.changes === 1;
}

/** Every version of a plan, oldest first (the history is kept). */
export function planVersions(db: Database, id: string): WorkPlanRow[] {
  return db
    .query<WorkPlanRow, [string]>(`SELECT ${COLUMNS} FROM work_plans WHERE id = ? ORDER BY version`)
    .all(id);
}

/** Id of the plan of a goal (a goal has one plan; its versions share the id), or undefined. */
export function planIdOfGoal(db: Database, goalId: string): string | undefined {
  return db
    .query<{ id: string }, [string]>(
      "SELECT id FROM work_plans WHERE goal_id = ? ORDER BY created_at DESC, version DESC LIMIT 1",
    )
    .get(goalId)?.id;
}

/** A `draft` / `valid` version older than this (ms) no longer holds its goal open: the owner never answered. */
export const PENDING_PLAN_MAX_AGE_MS = 30 * 60 * 1000;

/** True while a recent version of the goal's plan waits for the owner (`draft` or `valid`): the goal is not finished. */
export function hasPendingPlan(db: Database, goalId: string, now = Date.now()): boolean {
  return (
    db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM work_plans WHERE goal_id = ? AND status IN ('draft', 'valid') AND created_at > ?",
      )
      .get(goalId, now - PENDING_PLAN_MAX_AGE_MS)?.n !== 0
  );
}

/**
 * Close every `draft` / `valid` version of the goal's plans (the goal was stopped or cancelled): `rejected` when the
 * plan never had an approved version (nothing was agreed), else `superseded` (the approved one stays in the history).
 * Returns how many versions were closed.
 */
export function closePendingPlans(db: Database, goalId: string, reason: string): number {
  return db
    .query(
      `UPDATE work_plans SET reason = ?,
         status = CASE WHEN EXISTS (SELECT 1 FROM work_plans a WHERE a.id = work_plans.id AND a.status = 'approved')
                       THEN 'superseded' ELSE 'rejected' END
       WHERE goal_id = ? AND status IN ('draft', 'valid')`,
    )
    .run(reason, goalId).changes;
}
