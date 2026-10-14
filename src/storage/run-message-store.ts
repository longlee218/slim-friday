import type { Database } from "bun:sqlite";
import { redactClip } from "../observability/redact";

/* Owner messages that arrived while a task ran (Rev 11): the audit of what the app did with each one. The row is
   written BEFORE the message is acted on; `status` then follows its fate. The body is redacted and capped here,
   so no caller can store a raw secret. Logs carry `len` only (never the body). */

/** Longest content kept per row (chars, after redaction; a cut ends with an ellipsis). */
export const RUN_MESSAGE_MAX_CHARS = 2000;

/** Rows older than this are purged at startup (code constant: no env knob). */
export const RUN_MESSAGES_RETENTION_DAYS = 14;

/** What the owner meant: `steer` = supplement of the running work, `followup` = independent work, `stop` = interrupt, `replace` = stop AND start the message's own request instead. */
export type RunMessageKind = "steer" | "followup" | "stop" | "replace" | "other";

/** `pending` = acted on, not confirmed yet (a steer waiting for the model to read it); the rest are final. */
export type RunMessageStatus = "pending" | "delivered" | "skipped" | "dropped";

/** One stored message. */
export interface RunMessageRow {
  id: string;
  messageId: string | null;
  threadId: string;
  sessionId: string | null;
  runId: string | null;
  /** Arrival order within the thread (1, 2, ...). */
  seq: number;
  kind: RunMessageKind;
  status: RunMessageStatus;
  content: string;
  createdAt: number;
  taskId: string | null;
}

const COLS = `id, message_id AS messageId, thread_id AS threadId, session_id AS sessionId, run_id AS runId,
  seq, kind, status, content, created_at AS createdAt, task_id AS taskId`;

/** Store one message: `seq` = next arrival number of the thread; content redacted, then capped. Returns the row id. */
export function insertRunMessage(
  db: Database,
  m: {
    messageId?: string;
    threadId: string;
    sessionId?: string;
    runId?: string;
    kind: RunMessageKind;
    status?: RunMessageStatus;
    content: string;
    /** Task the message was meant for (a held steer learns it when it is delivered: `setRunMessageTarget`). */
    taskId?: string;
  },
  now = Date.now(),
): string {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO run_messages (id, message_id, thread_id, session_id, run_id, seq, kind, status, content, created_at, task_id)
     VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM run_messages WHERE thread_id = ?), ?, ?, ?, ?, ?)`,
  ).run(
    id,
    m.messageId ?? null,
    m.threadId,
    m.sessionId ?? null,
    m.runId ?? null,
    m.threadId,
    m.kind,
    m.status ?? "pending",
    redactClip(m.content, RUN_MESSAGE_MAX_CHARS), // redactText first, then a surrogate-safe cut that leaves no secret tail
    now,
    m.taskId ?? null,
  );
  return id;
}

/** Ingress message id (Discord) of a stored message, or undefined (no such row, or no id was known). */
export function runMessageSourceId(db: Database, id: string): string | undefined {
  return (
    db
      .query<{ m: string | null }, [string]>(
        "SELECT message_id AS m FROM run_messages WHERE id = ?",
      )
      .get(id)?.m ?? undefined
  );
}

/** Move a row to a new status (a final status is never reopened: only `pending` rows change). */
export function setRunMessageStatus(db: Database, id: string, status: RunMessageStatus): boolean {
  return (
    db
      .query("UPDATE run_messages SET status = ? WHERE id = ? AND status = 'pending'")
      .run(status, id).changes > 0
  );
}

/** Point a stored message at the task that finally took it (a steer held until the run started). */
export function setRunMessageTarget(db: Database, id: string, taskId: string): void {
  db.query("UPDATE run_messages SET task_id = ? WHERE id = ?").run(taskId, id);
}

/** The thread's messages in arrival order (tests, diagnostics). */
export function listRunMessages(db: Database, threadId: string): RunMessageRow[] {
  return db
    .query<RunMessageRow, [string]>(
      `SELECT ${COLS} FROM run_messages WHERE thread_id = ? ORDER BY seq`,
    )
    .all(threadId);
}

/** Delete rows older than the retention; returns how many. */
export function purgeRunMessages(
  db: Database,
  now = Date.now(),
  days = RUN_MESSAGES_RETENTION_DAYS,
): number {
  return db.query("DELETE FROM run_messages WHERE created_at < ?").run(now - days * 86_400_000)
    .changes;
}
