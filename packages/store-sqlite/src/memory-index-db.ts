import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryOwner } from "@friday/core";

/** Bump when the tables change: an index with another version is dropped and rebuilt from its sources. */
const SCHEMA_VERSION = 2;
/** Shortest query word searched (one letter matches too much). */
const MIN_WORD = 2;
/** Tokenizer of every FTS table: diacritics folded, so "trien khai" finds "triển khai". */
const TOKENIZE = "tokenize = 'unicode61 remove_diacritics 2'";

/** `bot:<id>` or `group:<id>`: the key every note row is scoped by. */
export const ownerKey = (o: MemoryOwner): string =>
  o.kind === "bot" ? `bot:${o.botId}` : `group:${o.groupId}`;

/** Text as the index sees it: NFC, lower case, `đ` as `d` (FTS5 folds other diacritics itself). */
export const fold = (s: string): string => s.normalize("NFC").toLowerCase().replace(/đ/g, "d");

/**
 * An FTS5 MATCH for the words of `query`: each word quoted (so operators and punctuation are plain text) and
 * OR-ed, so a row with more of the words ranks higher. Empty when no word is long enough.
 */
export function matchOf(query: string): string {
  const words = new Set(
    fold(query)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= MIN_WORD),
  );
  return [...words].map((w) => `"${w}"`).join(" OR ");
}

/** Create the tables of a fresh index: notes (`docs`, `chunks`) and past messages. */
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
  db.run(`CREATE VIRTUAL TABLE chunks_fts USING fts5(body, ${TOKENIZE})`);
  db.run(
    `CREATE TABLE messages (
      id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, author_kind TEXT NOT NULL,
      author_bot_id TEXT, at INTEGER NOT NULL, text TEXT NOT NULL)`,
  );
  db.run("CREATE INDEX messages_conversation_idx ON messages (conversation_id)");
  db.run(`CREATE VIRTUAL TABLE messages_fts USING fts5(body, ${TOKENIZE})`);
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
 * Open (creating if needed) the index db at `file`. The index only mirrors other data, so a file that is corrupt
 * or of another version is deleted and made again empty (the caller then refills it). The file and its WAL / SHM
 * sidecars are owner-only. `":memory:"` gives a throwaway db.
 */
export function openIndexDb(file: string): Database {
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
  return db;
}
