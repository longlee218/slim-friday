import type { Database } from "bun:sqlite";
import type { Author, ConversationId, IndexedMessage, MessageHit } from "@friday/core";
import { fold, matchOf } from "./memory-index-db";

/** One row of the `messages` table with its score. */
interface MessageRow {
  id: number;
  conversation_id: string;
  author_kind: string;
  author_bot_id: string | null;
  at: number;
  text: string;
  score: number;
}

/** Highest message id indexed, 0 when none. */
export function lastMessageId(db: Database): number {
  return db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM messages").get()?.id ?? 0;
}

/** Add messages in one transaction; an id already present is skipped (its FTS row too). */
export function addMessages(db: Database, rows: IndexedMessage[]): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO messages (id, conversation_id, author_kind, author_bot_id, at, text) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const fts = db.prepare("INSERT INTO messages_fts (rowid, body) VALUES (?, ?)");
  db.transaction(() => {
    for (const m of rows) {
      const botId = m.author.kind === "bot" ? m.author.botId : null;
      const r = insert.run(m.id, m.conversationId, m.author.kind, botId, m.at, m.text);
      if (r.changes) fts.run(m.id, fold(m.text));
    }
  })();
}

/** Best messages for the words of `query`, only inside `conversationIds`, best first. */
export function searchMessages(
  db: Database,
  conversationIds: ConversationId[],
  query: string,
  limit: number,
): MessageHit[] {
  const match = matchOf(query);
  if (!match || !conversationIds.length || limit < 1) return [];
  const marks = conversationIds.map(() => "?").join(", ");
  const rows = db
    .query<MessageRow, (string | number)[]>(
      `SELECT m.id, m.conversation_id, m.author_kind, m.author_bot_id, m.at, m.text, -bm25(messages_fts) AS score
       FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.conversation_id IN (${marks})
       ORDER BY bm25(messages_fts), m.id DESC LIMIT ?`,
    )
    .all(match, ...conversationIds, limit);
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    author: authorOf(r),
    at: r.at,
    text: r.text,
    score: r.score,
  }));
}

/** The author of a stored row. */
function authorOf(r: Pick<MessageRow, "author_kind" | "author_bot_id">): Author {
  if (r.author_kind === "bot") return { kind: "bot", botId: r.author_bot_id ?? "" };
  return r.author_kind === "system" ? { kind: "system" } : { kind: "user" };
}
