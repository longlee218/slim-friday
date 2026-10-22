import type { Database } from "bun:sqlite";
import { TURN_SELECT, type TurnRow } from "./turn-rows";

/** Run metrics joined to their turn, filtered to runs that started since `since`. */
const RUN_JOIN = "FROM runs r JOIN turns t ON t.id = r.turn_id WHERE t.started_at >= ?";

/** Cost, tokens and SDK turns since `since`: totals, per local day x role, per role, per model, per tool, top runs. */
export function costSummary(db: Database, since: number) {
  const totals = db
    .query(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(r.cost_usd), 0) AS cost_usd, COALESCE(SUM(r.turns), 0) AS sdk_turns,
         COALESCE(SUM(r.input_tokens), 0) AS input_tokens, COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
         COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(r.cache_creation_tokens), 0) AS cache_creation_tokens,
         SUM(r.outcome <> 'success') AS not_success, COALESCE(SUM(r.compactions), 0) AS compactions
       ${RUN_JOIN}`,
    )
    .get(since);
  const byDay = db
    .query(
      `SELECT date(t.started_at / 1000, 'unixepoch', 'localtime') AS day, t.role, SUM(r.cost_usd) AS cost_usd,
         COUNT(*) AS runs
       ${RUN_JOIN} GROUP BY day, t.role ORDER BY day`,
    )
    .all(since);
  const byRole = db
    .query(
      `SELECT t.role, COUNT(*) AS runs, SUM(r.cost_usd) AS cost_usd, AVG(r.cost_usd) AS avg_cost,
         SUM(r.turns) AS sdk_turns, AVG(r.turns) AS avg_turns, AVG(r.duration_ms) AS avg_ms,
         SUM(r.input_tokens + r.cache_read_tokens + r.cache_creation_tokens) AS in_tokens,
         SUM(r.output_tokens) AS output_tokens, SUM(r.outcome <> 'success') AS not_success
       ${RUN_JOIN} GROUP BY t.role ORDER BY cost_usd DESC`,
    )
    .all(since);
  const byModel = db
    .query(
      `SELECT r.model, COUNT(*) AS runs, SUM(r.cost_usd) AS cost_usd ${RUN_JOIN}
       GROUP BY r.model ORDER BY cost_usd DESC`,
    )
    .all(since);
  // Tool calls carry no timestamp of their own: the window follows the turn's start.
  const byTool = db
    .query(
      `SELECT c.tool, COUNT(*) AS calls, SUM(c.is_error) AS errors, AVG(c.duration_ms) AS avg_ms,
         SUM(c.duration_ms) AS total_ms
       FROM tool_calls c JOIN turns t ON t.id = c.turn_id WHERE t.started_at >= ?
       GROUP BY c.tool ORDER BY calls DESC LIMIT 25`,
    )
    .all(since);
  const topRuns = db
    .query<TurnRow, [number]>(
      `${TURN_SELECT} WHERE t.started_at >= ? ORDER BY cost_usd DESC NULLS LAST LIMIT 15`,
    )
    .all(since);
  return { totals, byDay, byRole, byModel, byTool, topRuns };
}
