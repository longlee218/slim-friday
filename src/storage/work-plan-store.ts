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
): boolean {
  const res = db
    .query(
      `UPDATE work_plans SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END
       WHERE id = ? AND version = ? AND status = ?`,
    )
    .run(to, to, Date.now(), id, version, from);
  return res.changes === 1;
}
