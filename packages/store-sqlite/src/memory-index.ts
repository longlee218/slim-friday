import type { Database } from "bun:sqlite";
import type {
  ConversationId,
  IndexChunk,
  IndexedMessage,
  MemoryIndexStore,
  MemoryOwner,
  MessageHit,
  MessageIndexStore,
  ScoredChunk,
} from "@friday/core";
import { fold, matchOf, openIndexDb, ownerKey } from "./memory-index-db";
import { addMessages, lastMessageId, searchMessages } from "./message-index";

/**
 * Open (creating if needed) the memory index at `file`: the notes of every bot and group and the past messages.
 * A damaged or older file is rebuilt empty (see `openIndexDb`); the caller refills it from the files and the engine db.
 */
export function openMemoryIndex(file: string): MemoryIndexStore & MessageIndexStore {
  return new SqliteMemoryIndex(openIndexDb(file));
}

/** The index on SQLite: note chunks in a plain table, their folded text in an FTS5 table with the same rowid; messages likewise. */
class SqliteMemoryIndex implements MemoryIndexStore, MessageIndexStore {
  constructor(private readonly db: Database) {}

  docHash(owner: MemoryOwner, docId: string): string | undefined {
    return this.db
      .query<{ hash: string }, [string, string]>(
        "SELECT hash FROM docs WHERE owner = ? AND doc_id = ?",
      )
      .get(ownerKey(owner), docId)?.hash;
  }

  docIds(owner: MemoryOwner): string[] {
    return this.db
      .query<{ doc_id: string }, [string]>("SELECT doc_id FROM docs WHERE owner = ?")
      .all(ownerKey(owner))
      .map((r) => r.doc_id);
  }

  upsertDoc(owner: MemoryOwner, docId: string, hash: string, chunks: IndexChunk[]): void {
    const key = ownerKey(owner);
    this.db.transaction(() => {
      this.deleteDoc(key, docId);
      this.db.run("INSERT INTO docs (owner, doc_id, hash) VALUES (?, ?, ?)", [key, docId, hash]);
      const insert = this.db.prepare(
        "INSERT INTO chunks (owner, doc_id, ref, path, at, text) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      );
      const fts = this.db.prepare("INSERT INTO chunks_fts (rowid, body) VALUES (?, ?)");
      for (const c of chunks) {
        const row = insert.get(key, docId, c.ref, c.path, c.at ?? null, c.text) as { id: number };
        fts.run(row.id, fold(c.text));
      }
    })();
  }

  removeDoc(owner: MemoryOwner, docId: string): void {
    this.db.transaction(() => this.deleteDoc(ownerKey(owner), docId))();
  }

  searchText(owner: MemoryOwner, query: string, limit: number): ScoredChunk[] {
    const match = matchOf(query);
    if (!match || limit < 1) return [];
    const rows = this.db
      .query<
        {
          doc_id: string;
          ref: string;
          path: string;
          at: string | null;
          text: string;
          score: number;
        },
        [string, string, number]
      >(
        `SELECT c.doc_id, c.ref, c.path, c.at, c.text, -bm25(chunks_fts) AS score
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ? AND c.owner = ?
         ORDER BY bm25(chunks_fts), c.id LIMIT ?`,
      )
      .all(match, ownerKey(owner), limit);
    return rows.map((r) => ({
      docId: r.doc_id,
      ref: r.ref,
      path: r.path,
      ...(r.at ? { at: r.at } : {}),
      text: r.text,
      score: r.score,
    }));
  }

  lastMessageId(): number {
    return lastMessageId(this.db);
  }

  addMessages(rows: IndexedMessage[]): void {
    addMessages(this.db, rows);
  }

  searchMessages(conversationIds: ConversationId[], query: string, limit: number): MessageHit[] {
    return searchMessages(this.db, conversationIds, query, limit);
  }

  close(): void {
    this.db.close();
  }

  /** Remove a doc, its chunks and their FTS rows (call inside a transaction). */
  private deleteDoc(key: string, docId: string): void {
    this.db.run(
      "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE owner = ? AND doc_id = ?)",
      [key, docId],
    );
    this.db.run("DELETE FROM chunks WHERE owner = ? AND doc_id = ?", [key, docId]);
    this.db.run("DELETE FROM docs WHERE owner = ? AND doc_id = ?", [key, docId]);
  }
}
