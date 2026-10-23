import type { Database } from "bun:sqlite";
import { type FtsChunk, ftsInsertMessage } from "./task-message-fts-store";

/** One stored message (append-only). */
export interface TaskMessageRow {
  /** Message id (shown as `M<id>`). */
  id: number;
  /** Thread of the task. */
  threadId: string;
  /** Goal of the task. */
  goalId: string;
  /** Item the message belongs to. */
  taskId: string;
  /** `teammate`, a role name, `system` or `owner`. */
  author: string;
  /** Message kind (see `message-kinds.ts`). */
  kind: string;
  /** Id of the message this one answers; null otherwise. */
  replyTo: number | null;
  /** Full redacted text. */
  text: string;
  /** JSON deliverables of a result; null otherwise. */
  files: string | null;
  /** Epoch ms created. */
  createdAt: number;
}

/** What a caller supplies; the id and the time are set here. */
export type NewTaskMessage = Omit<TaskMessageRow, "id" | "createdAt">;

const COLUMNS = `id, thread_id AS threadId, goal_id AS goalId, task_id AS taskId, author, kind,
  reply_to AS replyTo, text, files, created_at AS createdAt`;

/**
 * Insert a message and its search chunks in ONE transaction; returns the new id. The caller redacts the text and
 * builds the chunks (folded + original), so this module stays free of the memory and artifact layers.
 */
export function insertTaskMessage(db: Database, m: NewTaskMessage, chunks: FtsChunk[]): number {
  return db.transaction(() => {
    const id = Number(
      db
        .query(
          `INSERT INTO task_messages (thread_id, goal_id, task_id, author, kind, reply_to, text, files, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          m.threadId,
          m.goalId,
          m.taskId,
          m.author,
          m.kind,
          m.replyTo,
          m.text,
          m.files,
          Date.now(),
        ).lastInsertRowid,
    );
    ftsInsertMessage(db, { id, threadId: m.threadId }, chunks);
    return id;
  })();
}

/** One message by id, or undefined. */
export function getTaskMessage(db: Database, id: number): TaskMessageRow | undefined {
  return (
    db
      .query<TaskMessageRow, [number]>(`SELECT ${COLUMNS} FROM task_messages WHERE id = ?`)
      .get(id) ?? undefined
  );
}

/** Messages of one task in id order; `sinceId` = only newer ones, `limit` = page size (default: all). */
export function listTaskMessages(
  db: Database,
  taskId: string,
  opts: { sinceId?: number; limit?: number } = {},
): TaskMessageRow[] {
  return db
    .query<TaskMessageRow, [string, number, number]>(
      `SELECT ${COLUMNS} FROM task_messages WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?`,
    )
    .all(taskId, opts.sinceId ?? 0, opts.limit ?? -1);
}

/** Messages of every task of a thread in id order (same paging as `listTaskMessages`). */
export function listThreadMessages(
  db: Database,
  threadId: string,
  opts: { sinceId?: number; limit?: number } = {},
): TaskMessageRow[] {
  return db
    .query<TaskMessageRow, [string, number, number]>(
      `SELECT ${COLUMNS} FROM task_messages WHERE thread_id = ? AND id > ? ORDER BY id LIMIT ?`,
    )
    .all(threadId, opts.sinceId ?? 0, opts.limit ?? -1);
}

/** Newest message of a kind on a task (written at or after `sinceMs` when given), or undefined. */
export function lastMessageOf(
  db: Database,
  taskId: string,
  kind: string,
  sinceMs = 0,
): TaskMessageRow | undefined {
  return (
    db
      .query<TaskMessageRow, [string, string, number]>(
        `SELECT ${COLUMNS} FROM task_messages WHERE task_id = ? AND kind = ? AND created_at >= ? ORDER BY id DESC LIMIT 1`,
      )
      .get(taskId, kind, sinceMs) ?? undefined
  );
}
