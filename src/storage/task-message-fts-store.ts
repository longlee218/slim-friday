import type { Database } from "bun:sqlite";

/** One indexed chunk: the folded text (searched) and the same chunk in its own spelling (shown). */
export interface FtsChunk {
  folded: string;
  orig: string;
}

/** Index the chunks of a message (rows of `task_messages_fts`; no triggers, the caller owns the transaction). */
export function ftsInsertMessage(
  db: Database,
  m: { id: number; threadId: string },
  chunks: FtsChunk[],
): void {
  const stmt = db.query(
    "INSERT INTO task_messages_fts (text, message_id, thread_id, chunk, orig) VALUES (?, ?, ?, ?, ?)",
  );
  chunks.forEach((c, i) => {
    stmt.run(c.folded, m.id, m.threadId, i, c.orig);
  });
}

/** A search hit: the best chunk of a message. */
export interface MessageFtsHit {
  messageId: number;
  taskId: string;
  kind: string;
  author: string;
  /** FTS5 snippet of the folded text. */
  snip: string;
  folded: string;
  orig: string;
  /** BM25 (lower is better). */
  rank: number;
}

/**
 * Ranked chunk search over the messages of ONE thread. `match` is a ready FTS5 expression (the caller quotes the
 * terms). Chunks best first; one message may appear more than once.
 */
export function ftsSearchMessages(
  db: Database,
  q: { match: string; threadId: string; limit: number; snippetTokens: number },
): MessageFtsHit[] {
  return db
    .query<MessageFtsHit, [string, string, number]>(
      `SELECT m.id AS messageId, m.task_id AS taskId, m.kind, m.author,
         snippet(task_messages_fts, 0, '', '', '...', ${q.snippetTokens}) AS snip,
         task_messages_fts.text AS folded, task_messages_fts.orig AS orig, bm25(task_messages_fts) AS rank
       FROM task_messages_fts JOIN task_messages m ON m.id = task_messages_fts.message_id
       WHERE task_messages_fts MATCH ? AND task_messages_fts.thread_id = ?
       ORDER BY rank LIMIT ?`,
    )
    .all(q.match, q.threadId, q.limit);
}
