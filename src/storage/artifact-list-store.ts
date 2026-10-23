import type { Database } from "bun:sqlite";
import { type ArtifactRow, COLUMNS, IS_LATEST_VERSION } from "./artifact-store";

/** Filters of a channel listing: all optional, ANDed. `since` is epoch ms (created at or after). */
export interface ArtifactFilter {
  goalId?: string;
  threadId?: string;
  since?: number;
}

/**
 * Latest version of each artifact of ONE workspace channel (`channel` '' = the workspace level), newest first, at most `limit`.
 * Rows the code wrote itself (`summary` = 1: old result summaries, plan versions) are not deliverables and are left out.
 */
export function listChannelArtifacts(
  db: Database,
  workspace: string,
  channel: string,
  f: ArtifactFilter & { limit: number },
): ArtifactRow[] {
  const where = ["workspace = ?", "channel = ?", "summary = 0", IS_LATEST_VERSION];
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
      `SELECT ${COLUMNS} FROM artifacts a WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params);
}

/** Every version of the artifacts of one task with this title and origin, newest first (a re-forward reuses an equal one). */
export function taskArtifactsByTitle(
  db: Database,
  taskId: string,
  title: string,
  origin: "store" | "repo",
): ArtifactRow[] {
  return db
    .query<ArtifactRow, [string, string, string]>(
      `SELECT ${COLUMNS} FROM artifacts a WHERE task_id = ? AND title = ? AND origin = ? AND summary = 0
        ORDER BY version DESC, rowid DESC`,
    )
    .all(taskId, title, origin);
}

/** Drop the index rows of one artifact (before it is indexed again from a changed file). */
export function ftsDelete(db: Database, artifactId: string): void {
  db.query("DELETE FROM artifacts_fts WHERE artifact_id = ?").run(artifactId);
}

/** Record the snapshot a repo artifact was just re-indexed from: its size and file mtime (epoch ms). */
export function setSourceSnapshot(db: Database, id: string, size: number, mtime: number): void {
  db.query("UPDATE artifacts SET size = ?, source_mtime = ? WHERE id = ?").run(size, mtime, id);
}

/** Record the new size of a store artifact whose file was rewritten in place (a plan document that follows its plan). */
export function setArtifactSize(db: Database, id: string, size: number): void {
  db.query("UPDATE artifacts SET size = ? WHERE id = ?").run(size, id);
}
