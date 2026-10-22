import type { Database } from "bun:sqlite";

/** Row of `artifacts` (camelCase). */
export interface ArtifactRow {
  id: string;
  workspace: string;
  /** Channel yaml name, '' at the workspace level. */
  channel: string;
  goalId: string | null;
  taskId: string | null;
  threadId: string | null;
  title: string;
  /** File name without the `-vN` suffix. */
  name: string;
  kind: string;
  origin: "store" | "repo";
  /** Absolute path (store) or path relative to the location (repo). */
  path: string;
  location: string | null;
  producerRole: string | null;
  version: number;
  size: number;
  /** For a repo artifact: mtime (epoch ms) of the file snapshot the index was built from; null for a store file. */
  sourceMtime: number | null;
  /** 1 = a file the code wrote itself, not a deliverable (an old result summary, a plan version): hidden from list and search, still readable by id; 0 otherwise. */
  summary: number;
  createdAt: number;
}

/** Columns of `artifacts` as `ArtifactRow` fields. */
export const COLUMNS = `id, workspace, channel, goal_id AS goalId, task_id AS taskId, thread_id AS threadId, title, name, kind,
  origin, path, location, producer_role AS producerRole, version, size, source_mtime AS sourceMtime, summary,
  created_at AS createdAt`;

/** Record one artifact (a new version is a new row; nothing is overwritten). */
export function insertArtifact(db: Database, a: ArtifactRow): void {
  db.query(
    `INSERT INTO artifacts (id, workspace, channel, goal_id, task_id, thread_id, title, name, kind, origin, path,
       location, producer_role, version, size, source_mtime, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.id,
    a.workspace,
    a.channel,
    a.goalId,
    a.taskId,
    a.threadId,
    a.title,
    a.name,
    a.kind,
    a.origin,
    a.path,
    a.location,
    a.producerRole,
    a.version,
    a.size,
    a.sourceMtime,
    a.summary,
    a.createdAt,
  );
}

/** One artifact, or null when unknown. */
export function getArtifact(db: Database, id: string): ArtifactRow | null {
  return db.query<ArtifactRow, [string]>(`SELECT ${COLUMNS} FROM artifacts WHERE id = ?`).get(id);
}

/** Artifacts a goal produced, oldest first. */
export function listByGoal(db: Database, goalId: string): ArtifactRow[] {
  return db
    .query<ArtifactRow, [string]>(
      `SELECT ${COLUMNS} FROM artifacts WHERE goal_id = ? ORDER BY created_at, rowid`,
    )
    .all(goalId);
}

/**
 * SQL condition (table alias `a`): the row is the newest version of its name in its channel. Old `-vN` rows stay on disk
 * and readable by id, but listings and searches show only this one.
 */
export const IS_LATEST_VERSION = `a.version = (SELECT MAX(b.version) FROM artifacts b
  WHERE b.workspace = a.workspace AND b.channel = a.channel AND b.name = a.name)`;

/** Highest version of a name in a channel (0 when none): the next write is this + 1. */
export function latestVersion(
  db: Database,
  workspace: string,
  channel: string,
  name: string,
): number {
  return (
    db
      .query<{ v: number | null }, [string, string, string]>(
        "SELECT MAX(version) AS v FROM artifacts WHERE workspace = ? AND channel = ? AND name = ?",
      )
      .get(workspace, channel, name)?.v ?? 0
  );
}

/** One indexed chunk: the folded text (searched) and the same chunk in its own spelling (shown). */
export interface FtsChunk {
  folded: string;
  orig: string;
}

/** Index the chunks of an artifact (rows of `artifacts_fts`; one transaction, no triggers). */
export function ftsInsert(
  db: Database,
  a: { id: string; workspace: string; channel: string },
  chunks: FtsChunk[],
): void {
  const stmt = db.query(
    "INSERT INTO artifacts_fts (text, artifact_id, workspace, channel, chunk, orig) VALUES (?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() =>
    chunks.forEach((c, i) => {
      stmt.run(c.folded, a.id, a.workspace, a.channel, i, c.orig);
    }),
  )();
}

/** A search hit before the snippet is cut: the best chunk of an artifact. */
export interface FtsHit {
  artifactId: string;
  title: string;
  kind: string;
  origin: string;
  path: string;
  location: string | null;
  version: number;
  /** FTS5 snippet of the folded text. */
  snip: string;
  folded: string;
  orig: string;
  /** BM25 (lower is better). */
  rank: number;
}

/**
 * Ranked chunk search over the latest versions in ONE workspace (and one channel when given). `match` is a ready FTS5 expression (the caller
 * quotes the terms). Returns chunks, best first; one artifact may appear more than once.
 */
export function ftsSearch(
  db: Database,
  q: {
    match: string;
    workspace: string;
    channel?: string;
    /** Lookup filters on the artifact row; `since` is epoch ms (created at or after). */
    goalId?: string;
    threadId?: string;
    since?: number;
    limit: number;
    snippetTokens: number;
  },
): FtsHit[] {
  const where = [
    "artifacts_fts MATCH ?",
    "artifacts_fts.workspace = ?",
    "a.summary = 0",
    IS_LATEST_VERSION,
  ];
  const params: (string | number)[] = [q.match, q.workspace];
  if (q.channel !== undefined) {
    where.push("artifacts_fts.channel = ?");
    params.push(q.channel);
  }
  if (q.goalId !== undefined) {
    where.push("a.goal_id = ?");
    params.push(q.goalId);
  }
  if (q.threadId !== undefined) {
    where.push("a.thread_id = ?");
    params.push(q.threadId);
  }
  if (q.since !== undefined) {
    where.push("a.created_at >= ?");
    params.push(q.since);
  }
  params.push(q.limit);
  return db
    .query<FtsHit, (string | number)[]>(
      `SELECT a.id AS artifactId, a.title, a.kind, a.origin, a.path, a.location, a.version,
         snippet(artifacts_fts, 0, '', '', '...', ${q.snippetTokens}) AS snip,
         artifacts_fts.text AS folded, artifacts_fts.orig AS orig, bm25(artifacts_fts) AS rank
       FROM artifacts_fts JOIN artifacts a ON a.id = artifacts_fts.artifact_id
       WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`,
    )
    .all(...params);
}
