import type { Database } from "bun:sqlite";

/* Audit trail of the teammate's memory writes (`memory_audit`). Rows carry a bullet hash, never text. SQL lives here only. */

/** What a write did. */
export type MemoryAuditAction = "save" | "edit_delete" | "edit_replace";

/** One audit row (the id is generated). */
export interface MemoryAuditRow {
  ts: number;
  threadId: string;
  channel: string;
  role: string;
  action: MemoryAuditAction;
  /** `channel` or `journal`. */
  scope: string;
  /** 16 hex chars of sha1 over the normalized bullet (`bulletHash`). */
  hash: string;
  /** For `edit_replace`: hash of the bullet that was replaced. */
  oldHash?: string;
}

/** Append one row. No retention: rows are never pruned (owner decision). */
export function recordMemoryAudit(db: Database, r: MemoryAuditRow): void {
  db.query(
    "INSERT INTO memory_audit (ts, thread_id, channel, role, action, scope, hash, old_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(r.ts, r.threadId, r.channel, r.role, r.action, r.scope, r.hash, r.oldHash ?? null);
}
