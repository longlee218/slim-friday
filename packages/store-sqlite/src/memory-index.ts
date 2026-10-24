import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { IndexChunk, MemoryIndexStore, MemoryOwner, ScoredChunk } from "@friday/core";

/** Bump when the tables change: an index with another version is dropped and rebuilt from the files. */
const SCHEMA_VERSION = 1;
/** Shortest query word searched (one letter matches too much). */
const MIN_WORD = 2;

/** `bot:<id>` or `group:<id>`: the key every row is scoped by. */
const ownerKey = (o: MemoryOwner): string =>
  o.kind === "bot" ? `bot:${o.botId}` : `group:${o.groupId}`;

/** Text as the index sees it: NFC, lower case, `đ` as `d` (FTS5 folds other diacritics itself). */
const fold = (s: string): string => s.normalize("NFC").toLowerCase().replace(/đ/g, "d");

/**
 * An FTS5 MATCH for the words of `query`: each word quoted (so operators and punctuation are plain text) and
 * OR-ed, so a chunk with more of the words ranks higher. Empty when no word is long enough.
 */
function matchOf(query: string): string {
  const words = new Set(
    fold(query)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= MIN_WORD),
  );
  return [...words].map((w) => `"${w}"`).join(" OR ");
}

/** Create the tables of a fresh index. */
function createSchema(db: Database): void {
  db.run(
    "CREATE TABLE docs (owner TEXT NOT NULL, doc_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (owner, doc_id))",
  );
  db.run(
    `CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, owner TEXT NOT NULL, doc_id TEXT NOT NULL,
      ref TEXT NOT NULL, path TEXT NOT NULL, at TEXT, text TEXT NOT NULL)`,
  );
  db.run("CREATE INDEX chunks_doc_idx ON chunks (owner, doc_id)");
  db.run(
    "CREATE VIRTUAL TABLE chunks_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2')",
  );
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Open `file`; throws when it is not a usable index of the current version. */
function openChecked(file: string): Database {
  const db = new Database(file, { create: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    if (version?.user_version === 0) createSchema(db);
    else if (version?.user_version !== SCHEMA_VERSION)
      throw new Error(`memory index version ${version?.user_version}`);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Open (creating if needed) the memory index at `file`. The index only mirrors the memory files, so a file that
 * is corrupt or of another version is deleted and made again empty (the caller then reindexes). The file and its
 * WAL / SHM sidecars are owner-only. `":memory:"` gives a throwaway index.
 */
export function openMemoryIndex(file: string): MemoryIndexStore {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let db: Database;
  try {
    db = openChecked(file);
  } catch {
    if (file === ":memory:") throw new Error("memory index could not be created");
    for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
    db = openChecked(file);
  }
  if (file !== ":memory:")
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  return new SqliteMemoryIndex(db);
}

/** `MemoryIndexStore` on SQLite: chunks in a plain table, their folded text in an FTS5 table with the same rowid. */
class SqliteMemoryIndex implements MemoryIndexStore {
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
