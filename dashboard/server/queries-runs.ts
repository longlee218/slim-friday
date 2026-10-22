import type { Database } from "bun:sqlite";
import { TURN_SELECT, type TurnRow } from "./turn-rows";

/** One tool call, in call order (`tool_calls` has no timestamp: rowid is the order, duration the size). */
interface StepRow {
  id: string;
  tool: string;
  input_json: string;
  output_preview: string;
  is_error: number;
  duration_ms: number;
  agent_id: string | null;
}

/** A run's steps, its item (brief and result), the owner approvals it waited on. */
export function turnDetail(db: Database, turnId: string) {
  const turn = db.query<TurnRow, [string]>(`${TURN_SELECT} WHERE t.id = ?`).get(turnId);
  if (!turn) return null;
  const steps = db
    .query<StepRow, [string]>(
      `SELECT id, tool, input_json, output_preview, is_error, duration_ms, agent_id
       FROM tool_calls WHERE turn_id = ? ORDER BY rowid`,
    )
    .all(turnId);
  const item = turn.owned_task_id
    ? db
        .query(
          `SELECT id, item_key, parent_id, owner_role, status, subject, brief, result_kind, result_text,
             result_excerpt, attempt, dispatch_count, location
           FROM owned_tasks WHERE id = ?`,
        )
        .get(turn.owned_task_id)
    : null;
  const approvals = db
    .query(
      `SELECT id, tool, summary, decision, requested_at, decided_at FROM approvals
       WHERE turn_id = ? ORDER BY requested_at`,
    )
    .all(turnId);
  const extra = db
    .query<{ brief: string | null; session_id: string | null; kind: string; parent_turn_id: string | null }, [string]>(
      "SELECT brief, session_id, kind, parent_turn_id FROM turns WHERE id = ?",
    )
    .get(turnId);
  return { turn: { ...turn, ...extra }, steps, item, approvals };
}
