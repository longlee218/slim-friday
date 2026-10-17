import type { Database } from "bun:sqlite";
import { type ArtifactRow, COLUMNS } from "./artifact-store";

/** Filters of a channel listing: all optional, ANDed. `since` is epoch ms (created at or after). */
export interface ArtifactFilter {
  goalId?: string;
  threadId?: string;
  since?: number;
}

/** Artifacts of ONE workspace channel (`channel` '' = the workspace level), newest first, at most `limit`. */
export function listChannelArtifacts(
  db: Database,
  workspace: string,
  channel: string,
  f: ArtifactFilter & { limit: number },
): ArtifactRow[] {
  const where = ["workspace = ?", "channel = ?"];
  const params: (string | number)[] = [workspace, channel];
  if (f.goalId !== undefined) {
    where.push("goal_id = ?");
    params.push(f.goalId);
  }
  if (f.threadId !== undefined) {
    where.push("thread_id = ?");
    params.push(f.threadId);
  }
  if (f.since !== undefined) {
    where.push("created_at >= ?");
    params.push(f.since);
  }
  params.push(f.limit);
  return db
    .query<ArtifactRow, (string | number)[]>(
      `SELECT ${COLUMNS} FROM artifacts WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params);
}

/** Drop the index rows of one artifact (before it is indexed again from a changed file). */
export function ftsDelete(db: Database, artifactId: string): void {
  db.query("DELETE FROM artifacts_fts WHERE artifact_id = ?").run(artifactId);
}

/** Record the snapshot a repo artifact was just re-indexed from: its size and file mtime (epoch ms). */
export function setSourceSnapshot(db: Database, id: string, size: number, mtime: number): void {
  db.query("UPDATE artifacts SET size = ?, source_mtime = ? WHERE id = ?").run(size, mtime, id);
}
