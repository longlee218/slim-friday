import type { Database } from "bun:sqlite";
import { clip, redactText } from "../observability/redact";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../tools/sdk-tool-names";

/** Rejected plans recalled per thread. */
const REJECTED_PLANS_LIMIT = 5;
/** Max chars of one recalled brief. */
const REJECTED_BRIEF_MAX = 200;

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

/**
 * Briefs of delegated tasks the owner rejected, in this thread only, newest first (last 5),
 * whitespace-collapsed (cannot break out of its bullet), clipped and redacted.
 * Feeds the no-re-propose context block.
 *
 * Decision values the gateway writes (discord-approval.ts): `denied` = Reject click (or send failure),
 * `timeout` = owner never answered, `cancelled` = stop/shutdown/restart (run aborted, not a verdict),
 * `approved`. Only `denied` and `timeout` count as a rejection; `cancelled` does not.
 * Grouped per TASK: a plan can be denied, revised and then approved inside one task, so any task with
 * an approved ExitPlanMode row is excluded, and a task denied N times yields one row.
 */
export function rejectedPlans(db: Database, threadId: string): string[] {
  return db
    .query<{ brief: string }, [string, string, string, number]>(
      `SELECT t.brief AS brief FROM tasks t JOIN approvals a ON a.task_id = t.id
       WHERE t.thread_id = ? AND t.brief IS NOT NULL AND a.tool = ?
         AND NOT EXISTS (SELECT 1 FROM approvals ok WHERE ok.task_id = t.id
                         AND ok.tool = ? AND ok.decision = 'approved')
       GROUP BY t.id
       HAVING SUM(a.decision IN ('denied', 'timeout')) > 0
       ORDER BY MAX(a.requested_at) DESC, MAX(a.rowid) DESC LIMIT ?`,
    )
    .all(threadId, EXIT_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME, REJECTED_PLANS_LIMIT)
    .map((r) => clip(redactText(r.brief).replace(/\s+/g, " ").trim(), REJECTED_BRIEF_MAX));
}
