import type { Database } from "bun:sqlite";

/** One agent run's metrics. */
export interface RunRecord {
  id: string;
  turnId: string;
  model: string;
  /** Stage index (stages.idx) of the run; omitted = NULL (side answer, compaction, plain run without a stage). */
  stageIdx?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  turns: number;
  durationMs: number;
  outcome: string;
  compactions: number;
}

/** Insert a run row. */
export function insertRun(db: Database, r: RunRecord): void {
  db.query(
    `INSERT INTO runs (id, turn_id, model, input_tokens, output_tokens, cache_read_tokens,
       cache_creation_tokens, cost_usd, turns, duration_ms, outcome, compactions, stage_idx)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.turnId,
    r.model,
    r.inputTokens,
    r.outputTokens,
    r.cacheReadTokens,
    r.cacheCreationTokens,
    r.costUsd,
    r.turns,
    r.durationMs,
    r.outcome,
    r.compactions,
    r.stageIdx ?? null,
  );
}

/** One tool call; input/output must already be redacted + truncated. */
export interface ToolCallRecord {
  id: string;
  runId: string;
  tool: string;
  inputJson: string;
  outputPreview: string;
  isError: boolean;
  durationMs: number;
  /** Subagent that made the call; omitted = the main agent (NULL). */
  agentId?: string;
  /** Task the run belongs to (its `runs` row only exists once the run ends). */
  turnId?: string;
}

/** Insert (or replace on repeated tool_use id) a tool_calls row. */
export function insertToolCall(db: Database, c: ToolCallRecord): void {
  db.query(
    `INSERT OR REPLACE INTO tool_calls (id, run_id, tool, input_json, output_preview, is_error, duration_ms, agent_id, turn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.id,
    c.runId,
    c.tool,
    c.inputJson,
    c.outputPreview,
    c.isError ? 1 : 0,
    c.durationMs,
    c.agentId ?? null,
    c.turnId ?? null,
  );
}

/** Latest tool call of a turn (any run, subagent calls included): name and whether a subagent made it. */
export function latestToolCall(
  db: Database,
  turnId: string,
): { tool: string; subagent: boolean } | undefined {
  const row = db
    .query<{ tool: string; agent_id: string | null }, [string]>(
      "SELECT tool, agent_id FROM tool_calls WHERE turn_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(turnId);
  return row ? { tool: row.tool, subagent: row.agent_id !== null } : undefined;
}
