import type { Database } from "bun:sqlite";

/** One agent run's metrics. */
export interface RunRecord {
  id: string;
  turnId: string;
  model: string;
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
       cache_creation_tokens, cost_usd, turns, duration_ms, outcome, compactions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

/**
 * USD a task has cost so far: its own runs plus the runs of the tasks it resumes. A continuation (interrupt Resume, `/go`)
 * is a new turn row of kind `resume` whose `parent_turn_id` is the task it continues; the chain is followed up while the
 * child is a `resume`, so `TASK_BUDGET_USD` is a ceiling over the whole task, not over one run.
 */
export function spentByTask(db: Database, turnId: string): number {
  const row = db
    .query<{ usd: number }, [string]>(
      `WITH RECURSIVE chain(id, parent, resumed) AS (
         SELECT id, parent_turn_id, kind = 'resume' FROM turns WHERE id = ?
         UNION ALL
         SELECT t.id, t.parent_turn_id, t.kind = 'resume' FROM turns t JOIN chain c ON t.id = c.parent WHERE c.resumed
       )
       SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM runs WHERE turn_id IN (SELECT id FROM chain)`,
    )
    .get(turnId);
  return row?.usd ?? 0;
}

/** Outcome of the latest run of a turn (`max_budget`, `error`, ...), or undefined when it has no run row. */
export function lastRunOutcome(db: Database, turnId: string): string | undefined {
  return db
    .query<{ outcome: string }, [string]>(
      "SELECT outcome FROM runs WHERE turn_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(turnId)?.outcome;
}

/** Raw `input_json` of every call of tool `tool` in a turn (main agent and subagents), oldest first. */
export function toolInputsOfTurn(db: Database, turnId: string, tool: string): string[] {
  return db
    .query<{ input: string }, [string, string]>(
      "SELECT input_json AS input FROM tool_calls WHERE turn_id = ? AND tool = ? ORDER BY rowid",
    )
    .all(turnId, tool)
    .map((r) => r.input);
}
