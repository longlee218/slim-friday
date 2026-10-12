import type { Database } from "bun:sqlite";

/** Lifecycle of an approval row. */
export type ApprovalDecision = "pending" | "approved" | "denied" | "timeout" | "cancelled";

/** Insert a pending approval; summary must already be redacted. */
export function insertApproval(
  db: Database,
  a: { id: string; turnId: string; tool: string; summary: string },
): void {
  db.query(
    "INSERT INTO approvals (id, turn_id, tool, summary, decision, requested_at) VALUES (?, ?, ?, ?, 'pending', ?)",
  ).run(a.id, a.turnId, a.tool, a.summary, Date.now());
}

/** Record the final decision and time. */
export function decideApproval(db: Database, id: string, decision: ApprovalDecision): void {
  db.query("UPDATE approvals SET decision = ?, decided_at = ? WHERE id = ?").run(
    decision,
    Date.now(),
    id,
  );
}
