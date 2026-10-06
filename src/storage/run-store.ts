import type { Database } from "bun:sqlite";

/** Final status of a task row. */
export type TaskStatus =
  | "running"
  | "waiting_approval"
  | "done"
  | "failed"
  | "cancelled"
  /** Cut short by a restart/shutdown; the thread gets a Resume offer, then the row becomes cancelled. */
  | "interrupted"
  | "timeout";

/** Change a task's status without ending it (no-op when the row is missing). */
export function setTaskStatus(db: Database, id: string, status: TaskStatus): void {
  db.query("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
}

/** Record the Claude session of a task (reported at `system/init`) and the cwd it runs in. */
export function setTaskSession(db: Database, id: string, sessionId: string, cwd: string): void {
  db.query("UPDATE tasks SET session_id = ?, session_cwd = ? WHERE id = ?").run(sessionId, cwd, id);
}

/** Latest task of a thread with the session it recorded (what Resume continues), or null. */
export function latestTaskSession(
  db: Database,
  threadId: string,
): { status: string; repo: string; sessionId: string | null; cwd: string | null } | null {
  return db
    .query<
      { status: string; repo: string; sessionId: string | null; cwd: string | null },
      [string]
    >(
      `SELECT status, repo, session_id AS sessionId, session_cwd AS cwd FROM tasks
       WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(threadId);
}

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

/** Mark every still-`running` task `interrupted` (restart/shutdown) and cancel their pending approvals. */
export function interruptRunningTasks(db: Database): void {
  const now = Date.now();
  db.query(
    "UPDATE tasks SET status = 'interrupted', ended_at = ? WHERE status IN ('running', 'waiting_approval')",
  ).run(now);
  // Buttons of a dead process can never be answered (a resumed run asks again).
  db.query(
    "UPDATE approvals SET decision = 'cancelled', decided_at = ? WHERE decision = 'pending'",
  ).run(now);
}

/** Threads that have an interrupted task (each needs one Resume notice). */
export function listInterruptedThreads(db: Database): string[] {
  return db
    .query<{ thread_id: string }, []>(
      "SELECT DISTINCT thread_id FROM tasks WHERE status = 'interrupted'",
    )
    .all()
    .map((r) => r.thread_id);
}

/** The thread was told: its interrupted tasks become plain `cancelled` (no repeat notice next start). */
export function ackInterrupted(db: Database, threadId: string): void {
  db.query(
    "UPDATE tasks SET status = 'cancelled' WHERE status = 'interrupted' AND thread_id = ?",
  ).run(threadId);
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

/** Number of code tasks currently running or waiting for approval (concurrency cap). */
export function countActiveCodeTasks(db: Database): number {
  return db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM tasks WHERE type = 'code' AND status IN ('running', 'waiting_approval')",
    )
    .get()!.n;
}

/** Lifecycle of an approval row. */
export type ApprovalDecision = "pending" | "approved" | "denied" | "timeout" | "cancelled";

/** Insert a pending approval; summary must already be redacted. */
export function insertApproval(
  db: Database,
  a: { id: string; taskId: string; tool: string; summary: string },
): void {
  db.query(
    "INSERT INTO approvals (id, task_id, tool, summary, decision, requested_at) VALUES (?, ?, ?, ?, 'pending', ?)",
  ).run(a.id, a.taskId, a.tool, a.summary, Date.now());
}

/** Record the final decision and time. */
export function decideApproval(db: Database, id: string, decision: ApprovalDecision): void {
  db.query("UPDATE approvals SET decision = ?, decided_at = ? WHERE id = ?").run(
    decision,
    Date.now(),
    id,
  );
}
