import type { Database } from "bun:sqlite";
import { redactText } from "../../observability/redact";
import {
  summaryHitId,
  summaryPath,
  THREAD_SUMMARY_MAX_CHARS,
} from "../../storage/thread-summary-store";
import { localDay } from "../memory-clock";
import { foldText } from "./fold-text";
import { chunkId, classifyFile, type FileInfo, readFileChunks } from "./memory-files";

/** Stored text of one chunk is clipped to this many chars (Get/Expand read the file, not the index). */
export const CHUNK_MAX_CHARS = 1200;

/** One row to insert into `memory_fts` (+ the file ledger row). */
interface Row {
  /** Original spelling (NFC); the searchable column is its folded form. */
  text: string;
  id: string;
  source: string;
  section: string;
  kind: string;
  date: string;
  workspace: string;
}

/**
 * Delete every index row of a path (file or `summary/<id>`) and its ledger row. Rows and ledger are written in
 * one transaction, so a path without a ledger row has no rows (new file): nothing to delete. Otherwise the
 * delete scans the UNINDEXED `path` column (a full scan; accepted at this scale).
 */
export function purgePath(db: Database, path: string): void {
  if (!ledger(db, path)) return;
  db.query("DELETE FROM memory_fts WHERE path = ?").run(path);
  db.query("DELETE FROM memory_files WHERE path = ?").run(path);
}

/** Replace all rows of `path` with `rows` and stamp the ledger, in one transaction. */
function replaceRows(
  db: Database,
  path: string,
  workspace: string,
  rows: Row[],
  mtime: number,
  size: number,
): void {
  const ins = db.query(
    "INSERT INTO memory_fts (text, orig, id, source, section, kind, date, workspace, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    purgePath(db, path);
    for (const r of rows)
      ins.run(
        foldText(r.text),
        r.text,
        r.id,
        r.source,
        r.section,
        r.kind,
        r.date,
        r.workspace,
        path,
      );
    db.query("INSERT INTO memory_files (path, workspace, mtime_ms, size) VALUES (?, ?, ?, ?)").run(
      path,
      workspace,
      Math.trunc(mtime),
      size,
    );
  })();
}

/**
 * Re-index ONE file from its current content (what `MemorySave` calls after a write). Paths that are not an
 * indexable memory file (the retired workspace and location files, a pending queue file...) are refused ("skipped"); a vanished or symlinked
 * file is purged ("removed").
 */
export function reindexFile(
  db: Database,
  home: string,
  file: string,
): "indexed" | "removed" | "skipped" {
  const info: FileInfo | null = classifyFile(home, file);
  if (!info) return "skipped";
  const res = readFileChunks(file, info);
  if (!res.ok) {
    purgePath(db, file);
    return "removed";
  }
  const rows = res.chunks.map((c) => ({
    text: redactText(c.text).normalize("NFC").slice(0, CHUNK_MAX_CHARS),
    id: chunkId(info, c),
    source: info.source,
    section: redactText(c.section),
    kind: c.kind,
    date: c.date,
    workspace: info.workspace,
  }));
  replaceRows(db, file, info.workspace, rows, res.mtimeMs, res.size);
  return "indexed";
}

/** Ledger state of a path, or null. */
export const ledger = (db: Database, path: string) =>
  db
    .query<{ mtime_ms: number; size: number }, [string]>(
      "SELECT mtime_ms, size FROM memory_files WHERE path = ?",
    )
    .get(path);

/** Index the episode of one thread: its summary plus key topics (redacted, clipped to the stored summary size). */
export function indexSummary(db: Database, r: SummaryRow): void {
  const row: Row = {
    text: redactText(r.key_topics ? `${r.summary}\n${r.key_topics}` : r.summary)
      .normalize("NFC")
      .slice(0, THREAD_SUMMARY_MAX_CHARS),
    id: summaryHitId(r.thread_id, r.cycle),
    source: "summary",
    section: "",
    kind: "",
    date: localDay(new Date(r.updated_at)),
    workspace: r.workspace,
  };
  replaceRows(db, summaryPath(r.thread_id), r.workspace, [row], r.updated_at, r.cycle);
}

export interface SummaryRow {
  thread_id: string;
  workspace: string;
  summary: string;
  key_topics: string;
  updated_at: number;
  cycle: number;
}
