import type { Database } from "bun:sqlite";

/** Final status of a task row. */
export type TaskStatus = "running" | "done" | "failed" | "cancelled" | "timeout";

/** Insert a task row in `running` state. */
export function insertTask(
  db: Database,
  t: { id: string; threadId: string; source: string; repo: string; type: string },
): void {
  db.query(
    "INSERT INTO tasks (id, thread_id, source, repo, type, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
  ).run(t.id, t.threadId, t.source, t.repo, t.type, Date.now());
}

/** Set final status and end time of a task. */
export function finishTask(db: Database, id: string, status: TaskStatus): void {
  db.query("UPDATE tasks SET status = ?, ended_at = ? WHERE id = ?").run(status, Date.now(), id);
}

/** Mark every still-`running` task cancelled (shutdown cleanup). */
export function cancelRunningTasks(db: Database): void {
  db.query("UPDATE tasks SET status = 'cancelled', ended_at = ? WHERE status = 'running'").run(
    Date.now(),
  );
}

/** One agent run's metrics. */
export interface RunRecord {
  id: string;
  taskId: string;
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
    `INSERT INTO runs (id, task_id, model, input_tokens, output_tokens, cache_read_tokens,
       cache_creation_tokens, cost_usd, turns, duration_ms, outcome, compactions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.taskId,
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
}

/** Insert (or replace on repeated tool_use id) a tool_calls row. */
export function insertToolCall(db: Database, c: ToolCallRecord): void {
  db.query(
    `INSERT OR REPLACE INTO tool_calls (id, run_id, tool, input_json, output_preview, is_error, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.id, c.runId, c.tool, c.inputJson, c.outputPreview, c.isError ? 1 : 0, c.durationMs);
}
