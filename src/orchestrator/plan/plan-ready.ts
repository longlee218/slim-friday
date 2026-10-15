import type { Database } from "bun:sqlite";
import { latestPlan, planIdOfGoal } from "../../storage/work-plan-store";

/** The plan a goal waits on (`valid` = ready for the owner), or undefined: the planner's end event carries it so the lead is told. */
export function planReadyOf(
  db: Database,
  goalId: string,
): { planId: string; version: number; status: string } | undefined {
  const id = planIdOfGoal(db, goalId);
  const row = id ? latestPlan(db, id) : undefined;
  return row?.status === "valid"
    ? { planId: row.id, version: row.version, status: row.status }
    : undefined;
}
