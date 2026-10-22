import type { Database } from "bun:sqlite";

/** One agent run (a `turns` row) with its metrics and tool-call counts: the unit every view draws. */
export interface TurnRow {
  id: string;
  thread_id: string;
  role: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  owned_task_id: string | null;
  item_key: string | null;
  model: string | null;
  cost_usd: number | null;
  sdk_turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  outcome: string | null;
  compactions: number | null;
  tool_calls: number;
  tool_errors: number;
  last_tool: string | null;
}

/** Shared SELECT; callers append WHERE/ORDER. Runs are 1:1 with turns but SUM keeps a retried row safe. */
export const TURN_SELECT = `
  SELECT t.id, t.thread_id, t.role, t.status, t.started_at, t.ended_at, t.owned_task_id,
    o.item_key,
    (SELECT r.model FROM runs r WHERE r.turn_id = t.id LIMIT 1) AS model,
    (SELECT SUM(r.cost_usd) FROM runs r WHERE r.turn_id = t.id) AS cost_usd,
    (SELECT SUM(r.turns) FROM runs r WHERE r.turn_id = t.id) AS sdk_turns,
    (SELECT SUM(r.input_tokens) FROM runs r WHERE r.turn_id = t.id) AS input_tokens,
    (SELECT SUM(r.output_tokens) FROM runs r WHERE r.turn_id = t.id) AS output_tokens,
    (SELECT SUM(r.cache_read_tokens) FROM runs r WHERE r.turn_id = t.id) AS cache_read_tokens,
    (SELECT SUM(r.cache_creation_tokens) FROM runs r WHERE r.turn_id = t.id) AS cache_creation_tokens,
    (SELECT r.outcome FROM runs r WHERE r.turn_id = t.id LIMIT 1) AS outcome,
    (SELECT SUM(r.compactions) FROM runs r WHERE r.turn_id = t.id) AS compactions,
    (SELECT COUNT(*) FROM tool_calls c WHERE c.turn_id = t.id) AS tool_calls,
    (SELECT COUNT(*) FROM tool_calls c WHERE c.turn_id = t.id AND c.is_error = 1) AS tool_errors,
    (SELECT c.tool FROM tool_calls c WHERE c.turn_id = t.id ORDER BY c.rowid DESC LIMIT 1) AS last_tool
  FROM turns t LEFT JOIN owned_tasks o ON o.id = t.owned_task_id`;

/** Turns of a thread whose span overlaps [from, to]: the lead runs that served one goal. */
export function leadTurnsInWindow(db: Database, threadId: string, from: number, to: number): TurnRow[] {
  return db
    .query<TurnRow, [string, number, number]>(
      `${TURN_SELECT} WHERE t.thread_id = ? AND t.role = 'lead'
         AND COALESCE(t.ended_at, 9e15) >= ? AND t.started_at <= ? ORDER BY t.started_at`,
    )
    .all(threadId, from, to);
}
