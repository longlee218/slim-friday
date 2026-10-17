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
  createdAt: number;
}

/** Columns of `artifacts` as `ArtifactRow` fields. */
const COLUMNS = `id, workspace, channel, goal_id AS goalId, task_id AS taskId, thread_id AS threadId, title, name, kind,
  origin, path, location, producer_role AS producerRole, version, size, created_at AS createdAt`;

/** Record one artifact (a new version is a new row; nothing is overwritten). */
export function insertArtifact(db: Database, a: ArtifactRow): void {
  db.query(
    `INSERT INTO artifacts (id, workspace, channel, goal_id, task_id, thread_id, title, name, kind, origin, path,
       location, producer_role, version, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
 * Ranked chunk search in ONE workspace (and one channel when given). `match` is a ready FTS5 expression (the caller
 * quotes the terms). Returns chunks, best first; one artifact may appear more than once.
 */
export function ftsSearch(
  db: Database,
  q: { match: string; workspace: string; channel?: string; limit: number; snippetTokens: number },
): FtsHit[] {
  const where = ["artifacts_fts MATCH ?", "artifacts_fts.workspace = ?"];
  const params: (string | number)[] = [q.match, q.workspace];
  if (q.channel !== undefined) {
    where.push("artifacts_fts.channel = ?");
    params.push(q.channel);
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
