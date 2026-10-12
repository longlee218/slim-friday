import type { Database } from "bun:sqlite";

/** Status of one stage row of a task. */
export type StageStatus = "running" | "done" | "interrupted" | "failed" | "cancelled";

/** One stage of a task (`idx` = position in the role's stage list). */
export interface StageRow {
  turnId: string;
  idx: number;
  name: string;
  status: StageStatus;
  sessionId: string | null;
  cwd: string | null;
  verdict: string | null;
  /** Model the stage ran on (resolved id, e.g. from `resolveModel`). */
  model: string | null;
  costUsd: number | null;
  startedAt: number | null;
  endedAt: number | null;
}

/** Key + required fields of an upsert; the other fields only overwrite when given. */
export type StageUpsert = Pick<StageRow, "turnId" | "idx" | "name" | "status"> &
  Partial<Omit<StageRow, "turnId" | "idx" | "name" | "status">>;

/**
 * Insert the stage row, or update it in place (same task + idx). Optional fields left undefined keep their
 * stored value, so `start` and `finish` can each write only what they know.
 */
export function upsertStage(db: Database, s: StageUpsert): void {
  db.query(
    `INSERT INTO stages (turn_id, idx, name, status, session_id, cwd, verdict, model, cost_usd, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (turn_id, idx) DO UPDATE SET
       name = excluded.name,
       status = excluded.status,
       session_id = COALESCE(excluded.session_id, stages.session_id),
       cwd = COALESCE(excluded.cwd, stages.cwd),
       verdict = COALESCE(excluded.verdict, stages.verdict),
       model = COALESCE(excluded.model, stages.model),
       cost_usd = COALESCE(excluded.cost_usd, stages.cost_usd),
       started_at = COALESCE(excluded.started_at, stages.started_at),
       ended_at = COALESCE(excluded.ended_at, stages.ended_at)`,
  ).run(
    s.turnId,
    s.idx,
    s.name,
    s.status,
    s.sessionId ?? null,
    s.cwd ?? null,
    s.verdict ?? null,
    s.model ?? null,
    s.costUsd ?? null,
    s.startedAt ?? null,
    s.endedAt ?? null,
  );
}

const COLS = `turn_id AS turnId, idx, name, status, session_id AS sessionId, cwd, verdict, model,
  cost_usd AS costUsd, started_at AS startedAt, ended_at AS endedAt`;

/** The stages of a task in order. */
export function listStages(db: Database, turnId: string): StageRow[] {
  return db
    .query<StageRow, [string]>(`SELECT ${COLS} FROM stages WHERE turn_id = ? ORDER BY idx`)
    .all(turnId);
}

/**
 * USD the task's stages OTHER than `idx` have cost so far (their `cost_usd`). The current stage is left out on purpose:
 * a resumed stage's session total already carries its own earlier cost. Feeds the per-run ceiling (`TASK_BUDGET_USD`; a `/go` re-run is a new turn row, so it starts at 0).
 */
export function spentByOtherStages(db: Database, taskId: string, idx: number): number {
  const row = db
    .query<{ usd: number }, [string, number]>(
      "SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM stages WHERE turn_id = ? AND idx <> ?",
    )
    .get(taskId, idx);
  return row?.usd ?? 0;
}

/** Mark every still-`running` stage `interrupted` (restart/shutdown, same rule as the task rows). */
export function interruptRunningStages(db: Database): void {
  db.query("UPDATE stages SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(
    Date.now(),
  );
}

/** Verdict of a stage whose owner gate (the plan) was approved. */
export const GATE_APPROVED_VERDICT = "approved";

/** The task already passed an approved gate: work after it runs on a plan the owner approved earlier. */
export function gatePassed(db: Database, taskId: string): boolean {
  return !!db
    .query("SELECT 1 FROM stages WHERE turn_id = ? AND verdict = ? LIMIT 1")
    .get(taskId, GATE_APPROVED_VERDICT);
}
